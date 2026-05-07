/**
 * DidDailyBriefingPanel
 *
 * Single source of truth pro Karlův denní hlas na DID dashboardu.
 * Čte výhradně z tabulky `did_daily_briefings` (generuje edge funkce
 * `karel-did-daily-briefing`). UI nikdy briefing nesestavuje samo —
 * jen ho renderuje.
 *
 * 2026-04-19 — VERTICAL SLICE 2:
 *  Klikatelné položky NEJSOU query-param shimy. Každý klik vede do
 *  KANONICKÉHO PERSISTENTNÍHO targetu:
 *
 *  - ask_hanka / ask_kata
 *      → did_threads s `workspace_type = 'ask_hanka' | 'ask_kata'`,
 *        `workspace_id = item.id` (stabilní serverové UUID v payloadu).
 *      Druhý klik na stejný ask otevře tentýž thread (přes
 *      `useDidThreads.getThreadByWorkspace`). První klik vlákno lazy-založí
 *      a vepíše Karlův úvod jako první assistant message.
 *
 *  - decisions  → karel-team-deliberation-create (typ podle d.type)
 *      → otevře persistentní `did_team_deliberations` přes
 *        `?deliberation_id=<id>`. Druhý klik nezakládá nový — pre-flight
 *        ilike-match (24h, status active/awaiting_signoff) reuse-uje
 *        existující poradu.
 *
 *  - proposed_session  → karel-team-deliberation-create
 *        s `deliberation_type='session_plan'` a subject_parts=[part_name].
 *      Schválená session-plan deliberation je pak bridgnutá do
 *      `did_daily_session_plans` (signoff funkce). Žádný `?did_submode`
 *      shim, žádný "mamka" workspace.
 *
 *  Backward compat: starší briefingy mají `ask_hanka: string[]`.
 *  Komponenta umí obojí — pro legacy položku se na stage klikání generuje
 *  ad-hoc UUID (deterministicky cachovaný v sessionStorage podle textu),
 *  takže idempotence funguje i bez nové edge generace.
 */

import { forwardRef, useEffect, useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import {
  Loader2, RefreshCw, Sparkles, CalendarDays, Users, AlertTriangle, ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useDidThreads } from "@/hooks/useDidThreads";
import type { DeliberationType } from "@/types/teamDeliberation";
import { pragueTodayISO } from "@/lib/dateOnlyTaskHelpers";
import ExternalLoadWarning from "@/components/did/ExternalLoadWarning";
import AiPolishCanaryPreviewPanel from "@/components/did/AiPolishCanaryPreviewPanel";
import { getBriefingTruthStatus, pluralizeDays } from "@/lib/briefingTruthStatus";
import { selectBestBriefing, isFullRenderableBriefing } from "@/lib/briefingSelection";
import { sanitizeKarelVisibleText } from "@/lib/karelBriefingVisibleSanitizer";

interface BriefingDecision {
  /** SLICE 3 — stabilní serverové UUID briefing itemu (linked_briefing_item_id). */
  id?: string;
  title: string;
  reason: string;
  type: "crisis" | "session_plan" | "clinical_decision" | "follow_up_review" | "supervision";
  part_name?: string;
}

/** SLICE 3 — strukturovaná osnova session-plan deliberation. */
interface AgendaBlock {
  block: string;
  minutes?: number | null;
  detail?: string | null;
}

interface ProposedSession {
  /** SLICE 3 — stabilní serverové UUID briefing itemu (linked_briefing_item_id). */
  id?: string;
  part_name: string;
  why_today: string;
  led_by: "Hanička" | "Káťa" | "společně";
  duration_min?: number;
  first_draft: string;
  kata_involvement?: string;
  carry_over_reason?: string;
  /** SLICE 3 — minutáž sezení (3-6 bloků). */
  agenda_outline?: AgendaBlock[];
  /** SLICE 3 — předem připravené otázky pro Haničku k tomuto sezení. */
  questions_for_hanka?: string[];
  /** SLICE 3 — předem připravené otázky pro Káťu k tomuto sezení. */
  questions_for_kata?: string[];
  backend_context_inputs?: Record<string, any>;
}

interface ProposedPlayroom {
  id?: string;
  part_name: string;
  status?: "draft" | "awaiting_therapist_review" | "in_revision" | "approved" | "ready_to_start" | "in_progress" | "completed" | "evaluated" | "archived";
  why_this_part_today: string;
  main_theme: string;
  evidence_sources?: string[];
  goals?: string[];
  playroom_plan: {
    therapeutic_program?: AgendaBlock[];
    child_safe_version?: string;
    micro_steps?: string[];
    expected_child_reactions?: string[];
    recommended_karel_responses?: string[];
    risks_and_stop_signals?: string[];
    forbidden_directions?: string[];
    runtime_packet_seed?: Record<string, unknown>;
  };
  questions_for_hanka?: string[];
  questions_for_kata?: string[];
  backend_context_inputs?: Record<string, any>;
}

type BriefingAskIntent =
  | "session_plan"
  | "playroom_plan"
  | "team_coordination"
  | "task"
  | "observation"
  | "current_handling"
  | "none";

type BriefingAskTargetType =
  | "proposed_session"
  | "proposed_playroom"
  | "team_deliberation"
  | "current_handling"
  | "task"
  | "none";

type BriefingAskExpectedResolution =
  | "update_program"
  | "add_observation"
  | "create_task"
  | "store_memory"
  | "no_program_change";

/** Nový tvar ask položky (id+text+metadata). Edge funkce vrací tohle od 2026-04-19. */
interface AskItemObj {
  id: string;
  text: string;
  assignee?: "hanka" | "kata";
  question_text?: string;
  intent?: BriefingAskIntent;
  target_type?: BriefingAskTargetType;
  target_item_id?: string | null;
  target_part_name?: string | null;
  requires_immediate_program_update?: boolean;
  expected_resolution?: BriefingAskExpectedResolution;
  source?: "daily_briefing" | string;
  briefing_id?: string;
  generated_at?: string;
}
type AskItemRaw = string | AskItemObj;

interface YesterdaySessionReview {
  exists?: boolean;
  held: boolean;
  status?: string;
  fallback_reason?: string;
  review_id?: string | null;
  plan_id?: string | null;
  part_name?: string;
  lead?: "Hanička" | "Káťa" | "společně";
  lead_person?: string | null;
  assistant_persons?: unknown[];
  completion?: "completed" | "partial" | "abandoned";
  practical_report_text?: string;
  detailed_analysis_text?: string;
  team_closing_text?: string;
  /** Karlovo přetlumočení sezení (4–7 vět, smysl ne provoz). */
  karel_summary: string;
  /** Klíčové zjištění o části (2–4 věty). */
  key_finding_about_part: string;
  /** Co z toho plyne pro terapeutický plán (2–4 věty). */
  implications_for_plan: string;
  /** Poděkování / stmelení týmu (1–3 věty). */
  team_acknowledgement: string;
}

interface YesterdayPlayroomReviewPayload {
  exists: boolean;
  status?: string;
  fallback_reason?: string;
  part_name?: string | null;
  plan_id?: string | null;
  thread_id?: string | null;
  review_id?: string | null;
  message_count?: number;
  practical_report_text?: string;
  detailed_analysis_text?: string;
  implications_for_part?: string;
  implications_for_system?: string;
  recommendations_for_therapists?: string;
  recommendations_for_next_playroom?: string;
  recommendations_for_next_session?: string;
  detail_analysis_drive_url?: string | null;
  practical_report_drive_url?: string | null;
  drive_sync_status?: string;
}

interface OpeningMonologuePayload {
  greeting?: string;
  team_recognition?: string;
  executive_summary?: string;
  parts_at_helm?: string;
  yesterday_new_information?: string;
  clinical_formulation?: string;
  recommendations_for_hana?: string;
  recommendations_for_katka?: string;
  what_not_to_do_today?: string;
  priority_of_the_day?: string;
  team_closing_line?: string;
  evidence_limits?: string;
  opening_monologue_text?: string;
  technical_note?: string;
}

interface BriefingPayload {
  greeting: string;
  recent_playroom_review?: RecencyMeta | null;
  recent_session_review?: RecencyMeta | null;
  viewer_meta?: {
    viewer_date_iso?: string | null;
    briefing_date_iso?: string | null;
    is_current_briefing?: boolean | null;
    days_since_briefing?: number | null;
  } | null;
  opening_monologue?: OpeningMonologuePayload | null;
  opening_monologue_text?: string;
  technical_note?: string;
  last_3_days: string;
  lingering?: string;
  daily_therapeutic_priority?: string;
  yesterday_session_review?: YesterdaySessionReview | null;
  yesterday_playroom_review?: YesterdayPlayroomReviewPayload | null;
  decisions: BriefingDecision[];
  proposed_session?: ProposedSession | null;
  proposed_playroom?: ProposedPlayroom | null;
  ask_hanka: AskItemRaw[];
  ask_kata: AskItemRaw[];
  waiting_for?: string[];
  closing: string;
  operational_context_used?: any[];
  hana_personal_did_relevant_implications?: any[];
}

export const realityContextText = (p: BriefingPayload): string => {
  const entries = [...(Array.isArray(p.operational_context_used) ? p.operational_context_used : []), ...(Array.isArray(p.hana_personal_did_relevant_implications) ? p.hana_personal_did_relevant_implications : [])];
  const match = entries.find((e: any) => /tim+m[iy]|kepork|rybi|real-world|skute|faktick|external_fact|therapist_factual_correction/i.test(`${e?.summary ?? ""} ${JSON.stringify(e?.detail ?? {})} ${e?.evidence_level ?? ""}`));
  if (!match) return "";
  const summary = cleanVisibleClinicalText(String(match.summary || match.detail?.operational_implication || "Hanička upřesnila důležitý faktický rámec, který má být dnes držen opatrně.").trim());
  return `${summary}\nSamo o sobě to ještě nevypovídá o tom, co prožívá konkrétní část. Terapeuticky důležité bude až to, co kluci sami řeknou, ukážou v těle nebo jak na téma zareagují.`;
};

export const backendContextSummary = (inputs: Record<string, any> | undefined): string => {
  if (!inputs) return "";
  const used = inputs.used_recent_operational_context || inputs.used_reality_correction || inputs.reality_correction_used || inputs.used_hana_personal_processed_implication;
  if (!used) return "";
  const limits = Array.isArray(inputs.what_not_to_conclude) ? inputs.what_not_to_conclude.filter(Boolean).slice(0, 2).join(" ") : "nedělat z reálné události automaticky projekci, symbol nebo diagnózu";
  // Recency-safe label: never freeze "včerejší" into the visible text.
  // The panel viewer may load this on a later day, when "včerejší" would lie.
  return cleanVisibleClinicalText(`Používá důležitý kontext z posledních dní. Čeho se dnes vyvarovat: ${limits}. Nejdřív ověřit vlastní reakci kluků.`);
};

export const cleanVisibleClinicalText = (value: unknown): string => String(value ?? "")
  .replace(/pending_review\s*\/\s*evidence_limited/gi, "otevřené nebo částečně rozpracované, zatím bez plného dovyhodnocení")
  .replace(/\bpending_review\b/gi, "čeká na klinické dovyhodnocení")
  .replace(/\bevidence_limited\b/gi, "zatím bez dostatečného materiálu pro plný klinický závěr")
  .replace(/\bneeds_therapist_input\b/gi, "čeká na doplnění od terapeutek")
  .replace(/therapist_factual_correction\s*\/\s*external_fact/gi, "Hanička upřesnila faktický rámec skutečné události")
  .replace(/\btherapist_factual_correction\b/gi, "Hanička upřesnila faktický rámec")
  .replace(/\bexternal_fact\b/gi, "skutečná událost")
  .replace(/faktick[áa]\s+korekce\s+reality/gi, "upřesněný faktický rámec")
  .replace(/\bchild evidence\b/gi, "vlastní slova, tělesná reakce nebo chování kluků")
  .replace(/\bevidence discipline\b/gi, "opatrnost v závěrech")
  .replace(/\breal-world\s+(?:context|kontext)\b/gi, "skutečná událost a její emoční rámec")
  .replace(/\breal-world\s+fact\b/gi, "skutečná událost")
  .replace(/\breal-world\b/gi, "skutečný")
  .replace(/Máme potvrzený started\/live\/progress signál/gi, "Máme potvrzený signál, že práce začala")
  .replace(/V ranním přehledu se má objevit jako [^\.\n]+, ne jako neuskutečněné Sezení\.?/gi, "V přehledu ho proto držím jako otevřený materiál, ne jako neuskutečněné Sezení.")
  .replace(/Timmi je reálný externí kontext/gi, "Timmi je skutečná událost a emoční kontext")
  .replace(/\bawaiting_therapist_review\b/gi, "čeká na schválení terapeutkami")
  .replace(/\boperational context\b|operační\s+kontext/gi, "důležitý kontext")
  .replace(/nepředstírat klinické závěry[^.\n]*/gi, "klinické závěry dělat až po vlastních slovech, tělesné reakci nebo chování kluků")
  .replace(/průběh, který nemá transcript/gi, "situaci, ke které zatím chybí dost přímého materiálu")
  .replace(/použít jen fakt zahájení/gi, "držet jen ověřené skutečnosti")
  .replace(/\btranscript\b/gi, "přímý záznam")
  .replace(/briefing_input|source_ref|source_kind|backend_context_inputs|processed_at|ingestion|Pantry B|karel_pantry_b_entries|did_event_ingestion_log/gi, "podklad")
  .trim();

const FORBIDDEN_VISIBLE_DEBUG_RE = /pending_review|evidence_limited|needs_therapist_input|awaiting_therapist_review|backend_context_inputs|source_ref|therapist_factual_correction|external_fact|evidence discipline|child evidence|real-world context|operational context|faktick[áa]\s+korekce\s+reality|nepředstírat klinické závěry|průběh, který nemá transcript|V ranním přehledu se má objevit|První pracovní návrh:\s*Část|Stav:\s*awaiting|Dnešní přehled drží|Karel je jen navigátor|Karel je zapisovatel|Karel nesmí|Karel může|Karel je\b|Karel bude|Sezení nesmí|Herna může běžet/i;

type RecencyMeta = {
  exists?: boolean;
  session_date_iso?: string | null;
  source_date_iso?: string | null;
  days_since_today?: number | null;
  days_since_briefing_date?: number | null;
  human_recency_label?: string | null;
  is_yesterday?: boolean;
  visible_label?: string | null;
  visible_sentence_prefix?: string | null;
  not_yesterday_notice?: string | null;
};

const formatPragueDateLabel = (iso?: string | null): string => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso.slice(0, 10))) return "datum není doložené";
  return new Intl.DateTimeFormat("cs-CZ", { timeZone: "Europe/Prague", day: "numeric", month: "numeric", year: "numeric" }).format(new Date(`${iso.slice(0, 10)}T12:00:00Z`));
};

const pragueTodayIso = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date());

const dateOnlyToUtcMs = (iso: string): number => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
};

/**
 * KALENDÁŘNÍ INTEGRITA — viewer-side revalidace.
 *
 * Cached briefing může mít zafrozenou recency z okamžiku generování
 * (`is_yesterday=true`, `days_since_today=1`). Když uživatel ten stejný
 * briefing otevře následující den, „včerejší" už neplatí. Tato funkce
 * přepočítá `is_yesterday`, `days_since_today` a všechny viditelné labely
 * proti aktuálnímu Europe/Prague datu — bez čekání na backend regeneraci.
 *
 * Pravidlo „včerejší smí být použito jen když source_date === viewer_date - 1"
 * je vynucováno právě tady.
 */
export const revalidateRecencyForViewer = (
  recency: RecencyMeta | null | undefined,
  viewerDateIso: string,
  kind: "playroom" | "session",
): RecencyMeta | null | undefined => {
  if (!recency || !recency.exists) return recency;
  const sourceIso = (recency.source_date_iso ?? recency.session_date_iso ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceIso)) return recency;
  const days = Math.round((dateOnlyToUtcMs(viewerDateIso) - dateOnlyToUtcMs(sourceIso)) / 86_400_000);
  const human =
    days === 0 ? "dnes" :
    days === 1 ? "včera" :
    days === 2 ? "předevčírem" :
    days === 3 ? "před 3 dny" :
    days > 3 ? `před ${days} dny` :
    "budoucí datum";
  const noun = kind === "playroom" ? "Herna" : "Sezení";
  const verb = kind === "playroom" ? "proběhla" : "proběhlo";
  const noYesterday = kind === "playroom" ? "Včera Herna neproběhla." : "Včerejší Sezení neproběhlo.";
  const visibleLabel =
    days === 1 ? `Včerejší ${noun}` :
    days === 2 ? `Předevčerejší ${noun}` :
    `Poslední ${noun}`;
  // Bezpečný absolute-date-first formát i pro days===1, aby se z věty
  // nestala zafixovaná lež po půlnoci ("Včerejší X proběhlo DD. M. YYYY"
  // se po půlnoci stává nepravdou). Vždy: datum + relativní badge.
  const prefix =
    days <= 2
      ? `Poslední ${noun} ${verb} ${formatPragueDateLabel(sourceIso)} — ${human}.`
      : `Poslední doložená ${noun} ${verb} ${formatPragueDateLabel(sourceIso)}, tedy ${human}.`;
  return {
    ...recency,
    source_date_iso: sourceIso,
    session_date_iso: sourceIso,
    days_since_today: days,
    days_since_briefing_date: days,
    is_yesterday: days === 1,
    human_recency_label: human,
    visible_label: visibleLabel,
    visible_sentence_prefix: prefix,
    not_yesterday_notice: days === 1 ? "" : noYesterday,
  };
};

export const getBriefingFreshnessMeta = (briefingDateIso: string | null | undefined, viewerDateIso: string) => {
  const briefingDate = String(briefingDateIso ?? "").slice(0, 10);
  const validBriefingDate = /^\d{4}-\d{2}-\d{2}$/.test(briefingDate);
  const daysSinceBriefing = validBriefingDate
    ? Math.round((dateOnlyToUtcMs(viewerDateIso) - dateOnlyToUtcMs(briefingDate)) / 86_400_000)
    : 0;
  return {
    viewer_date: viewerDateIso,
    briefing_date: validBriefingDate ? briefingDate : null,
    is_current_briefing: validBriefingDate && briefingDate === viewerDateIso,
    days_since_briefing: daysSinceBriefing,
  };
};

export const briefingFreshnessBannerText = (briefingDateIso: string | null | undefined, viewerDateIso: string): string => {
  const meta = getBriefingFreshnessMeta(briefingDateIso, viewerDateIso);
  if (meta.is_current_briefing) return "Tento přehled je pro dnešek aktuální.";
  const dateText = meta.briefing_date ? formatPragueDateLabel(meta.briefing_date) : "neznámého dne";
  return `Zobrazuji poslední dostupný přehled ze dne ${dateText}. Dnešní přehled zatím nevznikl.`;
};

const partInstrumental = (value?: string | null): string => {
  const raw = String(value ?? "").trim();
  if (!raw) return "doloženou částí";
  if (raw.toLowerCase() === "tundrupek") return "Tundrupkem";
  return raw;
};

export const recencySectionNoticeText = (kind: "playroom" | "session", recency?: RecencyMeta | null, partName?: string | null): string => {
  if (!recency?.exists || recency.is_yesterday) return "";
  const source = recency.source_date_iso ?? recency.session_date_iso;
  const dateLabel = formatPragueDateLabel(source);
  const human = recency.human_recency_label || "starší";
  if (kind === "playroom") {
    return `${recency.not_yesterday_notice || "Včera Herna neproběhla."} Poslední doložená Herna s ${partInstrumental(partName)} proběhla ${dateLabel}, tedy ${human}.`;
  }
  return `${recency.not_yesterday_notice || "Včerejší Sezení neproběhlo."} Poslední doložené Sezení proběhlo ${dateLabel}, tedy ${human}.`;
};

export const humanizeRecencyInProse = (value: unknown, playRecency?: RecencyMeta | null, sessRecency?: RecencyMeta | null): string => {
  let text = String(value ?? "");

  // Vždy zakázaný frozen pattern: "Včerejší X proběhl[ao] DD. M. YYYY."
  // Přepiš ho na absolute-date-first, i když je dnes opravdu včera —
  // jinak po půlnoci začne lhát z cache.
  if (playRecency?.exists && playRecency.source_date_iso) {
    const dateLabel = formatPragueDateLabel(playRecency.source_date_iso ?? playRecency.session_date_iso);
    const human = playRecency.human_recency_label || (playRecency.days_since_today === 1 ? "včera" : "");
    text = text.replace(
      /V[čc]erej[šs][íi]\s+Herna\s+prob[eě]hla\s+\d{1,2}\.\s*\d{1,2}\.\s*\d{4}\.?/giu,
      `Poslední Herna proběhla ${dateLabel}${human ? ` — ${human}` : ""}.`,
    );
  }
  if (sessRecency?.exists && sessRecency.source_date_iso) {
    const dateLabel = formatPragueDateLabel(sessRecency.source_date_iso ?? sessRecency.session_date_iso);
    const human = sessRecency.human_recency_label || (sessRecency.days_since_today === 1 ? "včera" : "");
    text = text.replace(
      /V[čc]erej[šs][íi]\s+Sezen[íi]\s+prob[eě]hlo\s+\d{1,2}\.\s*\d{1,2}\.\s*\d{4}\.?/giu,
      `Poslední Sezení proběhlo ${dateLabel}${human ? ` — ${human}` : ""}.`,
    );
  }

  // Sekční nadpis nesmí obsahovat "Včerejší", protože sekce mixuje dny.
  text = text.replace(/V[ČC]EREJ[ŠS][ÍI]\s+D[ŮU]LE[ŽZ]IT[ÝY]\s+KONTEXT/giu, "DŮLEŽITÝ KONTEXT Z POSLEDNÍCH DNÍ");

  if (playRecency?.exists && playRecency.days_since_today !== 1 && playRecency.days_since_today != null) {
    const dateLabel = formatPragueDateLabel(playRecency.source_date_iso ?? playRecency.session_date_iso);
    const label = playRecency.days_since_today === 2
      ? `předevčerejší Herna z ${dateLabel}`
      : `poslední Herna z ${dateLabel}, ${playRecency.human_recency_label || ""}`.trim();
    text = text
      .replace(/nav[áa]zat\s+na\s+v[čc]erej[šs][íi]\s+Hernu/giu, `navázat jen opatrně na ${label}`)
      .replace(/v[čc]erej[šs][íi]\s+hern[íi]\s+materi[áa]l/giu, `materiál z ${label}`)
      .replace(/v[čc]erej[šs][íi]\s+Hernu/giu, label)
      .replace(/v[čc]erej[šs][íi]\s+Herna/giu, label)
      .replace(/V[čc]erej[šs][íi]\s+Herna/gu, label.charAt(0).toUpperCase() + label.slice(1))
      .replace(/V[čc]erej[šs][íi]\s+herna/gu, label.charAt(0).toUpperCase() + label.slice(1))
      .replace(/ze\s+v[čc]erej[šs][íi]\s+Herny/giu, `z ${label}`)
      .replace(/Symboly\s+z\s+v[čc]erej[šs]ka/giu, `Symboly z ${playRecency.human_recency_label || "dřívějška"}`)
      .replace(/ze\s+v[čc]erej[šs]ka/giu, `z ${playRecency.human_recency_label || "dřívějška"}`)
      .replace(/\bv[čc]erej[šs]ka\b/giu, playRecency.human_recency_label || "posledního dne s Hernou");
  }
  if (sessRecency?.exists && sessRecency.days_since_today !== 1 && sessRecency.days_since_today != null) {
    const dateLabel = formatPragueDateLabel(sessRecency.source_date_iso ?? sessRecency.session_date_iso);
    const label = sessRecency.days_since_today === 2
      ? `předevčerejší Sezení z ${dateLabel}`
      : `poslední Sezení z ${dateLabel}, ${sessRecency.human_recency_label || ""}`.trim();
    text = text
      .replace(/v[čc]erej[šs][íi]\s+Sezen[íi]/giu, label)
      .replace(/V[čc]erej[šs][íi]\s+Sezen[íi]/gu, label.charAt(0).toUpperCase() + label.slice(1))
      .replace(/ze\s+v[čc]erej[šs][íi]ho\s+Sezen[íi]/giu, `z ${label}`);
  }
  return text;
};

/**
 * Defense-in-depth stripper: pokud staré cache (legacy briefing) nebo
 * zatoulaný LLM výstup obsahují větu typu "Včera Herna neproběhla." /
 * "Včerejší Sezení neproběhlo." apod. v úvodním Karlově monologu, odstraní ji.
 *
 * Tato informace patří VÝHRADNĚ do dedikované sekce "Poslední/Včerejší herna",
 * "Poslední/Včerejší sezení" a do auditovatelného bloku evidence_limits —
 * NIKDY ne jako první klinická věta Karlova ranního monologu.
 */
export const stripNotHeldNoticeFromOpening = (text: string): string => {
  if (!text) return text;
  const NOT_HELD_SENTENCE_RE =
    /(?:^|\s)(?:V[čc]era|V[čc]erej[šs][íi])\s+(?:Herna|Sezen[íi])\s+neprob[eě]hl[ao][^.!?\n]*[.!?]\s*/giu;
  const RECENCY_PREFIX_RE =
    /(?:^|\s)Posledn[íi]\s+dolo[žz]en[áaéeoé]?\s+(?:Herna|Sezen[íi])[^.!?\n]*?\d{1,2}\.\s*\d{1,2}\.\s*\d{4}[^.!?\n]*[.!?]\s*/giu;
  const DATED_RECENCY_RE =
    /(?:^|\s)(?:V[čc]erej[šs][íi]|P[řr]edev[čc]erej[šs][íi])\s+(?:Herna|Sezen[íi])\s+(?:prob[eě]hl[ao])\s+\d{1,2}\.\s*\d{1,2}\.\s*\d{4}[^.!?\n]*[.!?]\s*/giu;
  return text
    .replace(NOT_HELD_SENTENCE_RE, " ")
    .replace(RECENCY_PREFIX_RE, " ")
    .replace(DATED_RECENCY_RE, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

export const ensureKarelOpeningVoice = (value: unknown, playRecency?: RecencyMeta | null, sessRecency?: RecencyMeta | null): string => {
  const cleaned = stripNotHeldNoticeFromOpening(
    humanizeRecencyInProse(cleanVisibleClinicalText(value), playRecency, sessRecency),
  );
  if (!cleaned || FORBIDDEN_VISIBLE_DEBUG_RE.test(cleaned)) {
    return "Dobré ráno, Haničko a Káťo.\n\nVčerejší událost s Timmim/keporkakem vnímám jako silný emoční otisk v psychice kluků. Nechci ji dnes přehnaně vykládat, ale nechci ji ani ztratit. Potřebujeme jemně zjistit, co v nich po včerejšku zůstalo — vlastními slovy, tělem a reakcí kluků.\n\nPokud dnes proběhne Sezení, povede ho Hanička. Budu jí pomáhat držet strukturu, bezpečné otázky a zápis toho, co je klinicky důležité. Herna zůstává nízkoprahová a čeká na schválení terapeutkami.";
  }
  return cleaned;
};

const cleanLine = (value: unknown, fallback = ""): string => {
  const cleaned = cleanVisibleClinicalText(value);
  if (!cleaned || FORBIDDEN_VISIBLE_DEBUG_RE.test(cleaned)) return fallback;
  return cleaned;
};

interface SessionBlockView {
  title: string;
  duration: string;
  aim: string;
  therapist_instruction: string;
  observe: string[];
  record_for_karel: string[];
  stop_if: string[];
}

interface ProposedSessionView {
  title: string;
  part_name: string;
  lead: "Hanička" | "Káťa" | "obě terapeutky";
  duration: string;
  rationale: string;
  goals: string[];
  blocks: SessionBlockView[];
  therapist_script_examples: string[];
  stop_rules: string[];
  what_not_to_do: string[];
  status_label: string;
  executable: boolean;
}

interface ProposedPlayroomView {
  title: string;
  part_name: string;
  lead_label: string;
  approval_label: string;
  rationale: string;
  goals: string[];
  blocks: SessionBlockView[];
  child_safe_text?: string;
  stop_rules: string[];
}

const asCleanArray = (value: unknown, fallback: string[] = []): string[] => {
  const source = Array.isArray(value) && value.length > 0 ? value : fallback;
  return source.map((item) => cleanLine(item)).filter(Boolean).slice(0, 8);
};

const blockToView = (block: any, index: number, fallbackTitle: string): SessionBlockView => ({
  title: cleanLine(block?.block ?? block?.title, fallbackTitle),
  duration: typeof block?.minutes === "number" && block.minutes > 0 ? `${block.minutes} min` : `${index === 0 ? 8 : 10} min`,
  aim: cleanLine(block?.clinical_intent ?? block?.detail, "Bezpečně ověřit aktuální dostupnost bez předčasných závěrů."),
  therapist_instruction: cleanLine(block?.script ?? block?.therapist_instruction, "Terapeutka vede krok pomalu, nabízí volbu a průběžně ověřuje bezpečí."),
  observe: asCleanArray(block?.observe, ["míru zapojení", "změnu napětí", "doslovnou odpověď"]),
  record_for_karel: asCleanArray(block?.evidence_to_record ?? block?.record_for_karel, ["co bylo skutečně řečeno", "co zůstalo nejasné", "kdy bylo bezpečnější zpomalit"]),
  stop_if: asCleanArray(block?.stop_if, ["úzkost", "odmítnutí pokračovat", "ztráta bezpečí"]),
});

export const toProposedSessionView = (session: ProposedSession | null | undefined): ProposedSessionView | null => {
  if (!session?.part_name) return null;
  const rawBlocks = Array.isArray(session.agenda_outline) ? session.agenda_outline : [];
  const containsTechnicalFallback = FORBIDDEN_VISIBLE_DEBUG_RE.test(`${session.first_draft ?? ""} ${JSON.stringify(rawBlocks)}`) || rawBlocks.length === 1;
  const lead = session.led_by === "společně" ? "obě terapeutky" : session.led_by;
  if (containsTechnicalFallback || rawBlocks.length < 4) {
    return {
      title: `Sezení s částí ${cleanLine(session.part_name, "vybranou částí")}`,
      part_name: cleanLine(session.part_name, "vybraná část"),
      lead,
      duration: session.duration_min ? `~${session.duration_min} min` : "čeká na doplnění",
      rationale: "Karel zatím nemá dost podkladů pro vykonatelné Sezení. Potřebuje od Haničky nebo Káti upřesnit aktuální stav části, bezpečnost a dostupnost. Po doplnění vytvoří nový návrh.",
      goals: ["doplnit aktuální stav části", "ověřit bezpečí kontaktu", "určit, která terapeutka povede další krok"],
      blocks: [],
      therapist_script_examples: ["Co dnes o té části víme přímo?", "Je bezpečné ji zvát ke kontaktu, nebo dnes zůstat jen u stabilizace?"],
      stop_rules: ["dokud chybí bezpečnostní rámec, nespouštět program"],
      what_not_to_do: ["nevydávat jednoblokový fallback za živý program", "nenechat Karla vést terapeutem vedené Sezení samotného"],
      status_label: "není připraveno ke spuštění — čeká na terapeutické upřesnění",
      executable: false,
    };
  }
  return {
    title: `Sezení s částí ${cleanLine(session.part_name, "vybranou částí")}`,
    part_name: cleanLine(session.part_name, "vybraná část"),
    lead,
    duration: session.duration_min ? `~${session.duration_min} min` : "cca 45–60 min",
    rationale: cleanLine(session.why_today || session.first_draft, "Návrh vychází z dnešní priority a čeká na týmové doladění."),
    goals: asCleanArray((session as any).goals, ["bezpečně navázat kontakt", "ověřit aktuální stav", "získat přímý materiál pro další plán", "uzavřít měkce a bez tlaku"]),
    blocks: rawBlocks.slice(0, 6).map((b, i) => blockToView(b, i, ["Bezpečný vstup a ověření přítomnosti", "Tělesné a emoční mapování", "Opatrné otevření tématu", "Integrace a měkké ukončení"][i] ?? `Krok ${i + 1}`)),
    therapist_script_examples: ["Můžeme u toho zůstat jen krátce a bezpečně.", "Když to bude moc, zastavíme a vrátíme se k oporám."],
    stop_rules: ["úzkost", "stažení", "zmatek", "odmítnutí pokračovat"],
    what_not_to_do: ["netlačit na výklad", "nedělat závěr bez přímé reakce kluků"],
    status_label: "pracovní návrh k poradě — vede terapeutka, Karel asistuje",
    executable: true,
  };
};

export const toProposedPlayroomView = (playroom: ProposedPlayroom | null | undefined): ProposedPlayroomView | null => {
  if (!playroom?.part_name) return null;
  const blocks = Array.isArray(playroom.playroom_plan?.therapeutic_program) ? playroom.playroom_plan.therapeutic_program : [];
  return {
    title: `Návrh Herny s ${cleanLine(playroom.part_name, "vybranou částí")}`,
    part_name: cleanLine(playroom.part_name, "vybraná část"),
    lead_label: "vede Karel",
    approval_label: "čeká na schválení terapeutkami",
    rationale: cleanLine(playroom.why_this_part_today || playroom.main_theme, "Jemně ověřit, co dnes část unese, a držet bezpečný kontakt bez výkladu za ni."),
    goals: asCleanArray(playroom.goals, ["ověřit dnešní dostupnost", "držet bezpečný kontakt", "získat přímé odpovědi", "ukončit měkce"]),
    blocks: blocks.slice(0, 5).map((b, i) => blockToView(b, i, ["Bezpečný práh", "Jaké je dnes uvnitř počasí", "Držet realitu a emoci", "Co by dnes pomohlo", "Měkké ukončení"][i] ?? `Krok ${i + 1}`)),
    child_safe_text: cleanLine(playroom.playroom_plan?.child_safe_version),
    stop_rules: asCleanArray(playroom.playroom_plan?.risks_and_stop_signals, ["zahlcení", "odmítnutí", "ztráta bezpečí"]),
  };
};

interface BriefingRow {
  id: string;
  briefing_date: string;
  payload: BriefingPayload;
  generated_at: string;
  is_stale: boolean;
  proposed_session_part_id: string | null;
  decisions_count: number;
  generation_method?: string | null;
}

/**
 * Map generation_method → user-visible badge label.
 * - auto / cron / cron_secret                 → "Aktuální (auto)"
 * - sla_watchdog* / auto_repair_after_missed* / auto_sla_test → "Aktuální (SLA záplata)"
 * - manual / manual_* / null                  → "Aktuální (manuální)"
 */
function briefingMethodBadge(method?: string | null): { label: string; tone: "auto" | "sla" | "manual" } {
  const m = String(method || "").toLowerCase();
  if (!m || m === "manual" || m.startsWith("manual")) return { label: "Aktuální (manuální)", tone: "manual" };
  if (m.startsWith("sla_watchdog") || m === "auto_repair_after_missed_morning" || m === "auto_sla_test") {
    return { label: "Aktuální (SLA záplata)", tone: "sla" };
  }
  if (m === "auto" || m === "cron" || m === "cron_secret" || m.startsWith("auto") || m.startsWith("cron")) {
    return { label: "Aktuální (auto)", tone: "auto" };
  }
  // Unknown non-manual → treat as auto so we don't mislabel as manual
  return { label: "Aktuální (auto)", tone: "auto" };
}

interface BriefingDiagnostic {
  reason: string;
  detail: string;
  lastBriefingDate?: string | null;
  lastAttemptStatus?: string | null;
  lastAttemptCode?: string | null;
}

interface YesterdayFallbackReview extends YesterdaySessionReview {
  status_label?: string;
  mode?: "playroom" | "session";
  practical_report?: string | null;
  detailed_analysis?: string | null;
  sync_status?: string | null;
  team_closing?: string | null;
}

interface Props {
  refreshTrigger?: number;
  /** Otevře poradní místnost pro daný deliberation. Briefing decisions
   *  zatím poradu samy nezakládají — to je práce následujícího passu. */
  onOpenDeliberation?: (deliberationId: string) => void;
}

const TYPE_LABEL: Record<BriefingDecision["type"], string> = {
  crisis: "Krize",
  session_plan: "Plán sezení",
  clinical_decision: "Klinické rozhodnutí",
  follow_up_review: "Vyhodnocení sezení",
  supervision: "Supervize",
};

const TYPE_TONE: Record<BriefingDecision["type"], string> = {
  crisis: "bg-destructive/15 text-destructive border-destructive/30",
  session_plan: "bg-primary/10 text-primary border-primary/20",
  clinical_decision: "bg-accent/15 text-accent-foreground border-accent/30",
  follow_up_review: "bg-muted text-muted-foreground border-border",
  supervision: "bg-amber-500/15 text-amber-700 border-amber-500/30",
};

/** Mapování briefing decision typu → kanonický deliberation_type. */
const DECISION_TO_DELIB_TYPE: Record<BriefingDecision["type"], DeliberationType> = {
  crisis: "crisis",
  session_plan: "session_plan",
  clinical_decision: "team_task",
  follow_up_review: "followup_review",
  supervision: "supervision",
};

const formatDate = (iso: string): string => {
  try {
    const d = new Date(`${iso}T12:00:00`);
    return new Intl.DateTimeFormat("cs-CZ", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(d);
  } catch {
    return iso;
  }
};

const pragueYesterdayISO = (): string => {
  const today = pragueTodayISO();
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

const SectionHead = forwardRef<HTMLHeadingElement, { children: React.ReactNode; icon?: React.ReactNode }>(
  ({ children, icon }, ref) => (
  <h3 ref={ref} className="text-[12px] font-medium text-foreground/80 flex items-center gap-1.5 uppercase tracking-wide">
    {icon}
    {children}
  </h3>
));
SectionHead.displayName = "SectionHead";

const NarrativeDivider = forwardRef<HTMLDivElement>((_, ref) => (
  <div ref={ref} className="my-4 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
));
NarrativeDivider.displayName = "NarrativeDivider";

/**
 * Mark this navigation as originating from the briefing panel so that
 * `DidContentRouter` can route Back back to the `terapeut` dashboard.
 */
const markBriefingOrigin = () => {
  try {
    sessionStorage.setItem("karel_briefing_return", "1");
    sessionStorage.setItem("karel_hub_section", "did");
  } catch { /* ignore quota */ }
};

/**
 * Backward compat: pro legacy briefing s `ask_hanka: string[]` potřebujeme
 * stabilní pseudo-id, jinak by druhý klik na tentýž text otevřel jiný thread.
 * Klíč je odvozený z (briefing_id, role, text) a uložený v sessionStorage,
 * takže refresh stránky idempotenci nerozbije.
 */
const legacyAskIdFor = (
  briefingId: string,
  role: "ask_hanka" | "ask_kata",
  text: string,
): string => {
  const cacheKey = `legacy_ask_id::${briefingId}::${role}::${text.slice(0, 200)}`;
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) return cached;
  } catch { /* ignore */ }
  const id = (typeof crypto !== "undefined" && "randomUUID" in crypto)
    ? crypto.randomUUID()
    : `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try { sessionStorage.setItem(cacheKey, id); } catch { /* ignore */ }
  return id;
};

/** Normalizuje libovolnou ask položku na {id,text}. */
const toAskItem = (
  raw: AskItemRaw,
  briefingId: string,
  role: "ask_hanka" | "ask_kata",
): AskItemObj => {
  if (raw && typeof raw === "object" && "id" in raw && "text" in raw) {
    return { ...(raw as AskItemObj), id: String(raw.id), text: String(raw.text) };
  }
  const text = String(raw ?? "");
  return {
    id: legacyAskIdFor(briefingId, role, text),
    text,
    assignee: role === "ask_hanka" ? "hanka" : "kata",
    intent: "none",
    target_type: "none",
    target_item_id: null,
    target_part_name: null,
    requires_immediate_program_update: false,
    expected_resolution: "store_memory",
    source: "daily_briefing",
    briefing_id: briefingId,
  };
};

const createFallbackPlayroomProposal = (payload: BriefingPayload): ProposedPlayroom => {
  const session = payload.proposed_session;
  const partName = session?.part_name?.trim() || "část vybraná ranním přehledem";
  const why = session?.why_today?.trim()
    || payload.last_3_days?.trim()
    || "Ranní přehled zatím nemá uložený samostatný playroom payload, ale Herna musí mít každý den vlastní program k poradě.";

  return {
    part_name: partName,
    status: "awaiting_therapist_review",
    why_this_part_today: why,
    main_theme: `Bezpečný kontakt a cílené zmapování toho, co ${partName} dnes unese`,
    evidence_sources: ["Karlův ranní přehled", "návrh dnešního sezení", "poslední 3 dny"],
    goals: [
      "navázat kontakt bez tlaku na výkon",
      "rozlišit aktuální míru bezpečí, ochoty a únavy",
      "získat konkrétní materiál pro klinické vyhodnocení Herny",
      "ukončit včas při známkách zahlcení nebo stažení",
    ],
    playroom_plan: {
      therapeutic_program: [
        { block: "Bezpečný práh", minutes: 3, detail: "Karel nabídne dvě jednoduché volby kontaktu: slovo, emoji/symbol nebo ticho. Cílem je zjistit dostupnost části, ne ji tlačit do výkonu." },
        { block: "Mapa dnešního vnitřního počasí", minutes: 6, detail: "Část popíše obrazem, barvou nebo jedním slovem, jak se dnes uvnitř má. Karel sleduje míru konkrétnosti, vyhýbání a schopnost zůstat v kontaktu." },
        { block: "Symbolická hra s jednou postavou", minutes: 8, detail: "Karel nechá část vybrat postavu, místo nebo předmět a vede krátký dialog přes bezpečný symbol, bez otevírání traumatické paměti." },
        { block: "Co potřebuje malý krok", minutes: 5, detail: "Karel hledá jeden zvládnutelný mikro-krok pro dnešek: co pomůže tělu, kontaktu nebo klidu, bez slibů a bez konfrontace." },
        { block: "Měkké uzavření", minutes: 3, detail: "Karel shrne, co slyšel, nabídne bezpečné zakotvení a uloží body pro pozdější review." },
      ],
      child_safe_version: "Dnes si spolu jen opatrně zkusíme, jaké je uvnitř počasí, kdo tam je poblíž a co by pomohlo, aby toho nebylo moc.",
      micro_steps: ["vybrat způsob odpovědi", "pojmenovat obraz nebo barvu", "nechat symbol něco říct", "zvolit jeden malý pomocný krok", "společně zavřít hru"],
      expected_child_reactions: ["krátké odpovědi", "nejistota", "odmítnutí konkrétního tématu", "zájem o symbolickou postavu", "únava"],
      recommended_karel_responses: ["zpomalit", "nabídnout volbu", "potvrdit právo neodpovědět", "držet symbolickou rovinu", "ukončit dřív při zahlcení"],
      risks_and_stop_signals: ["náhlé stažení", "zmatek v čase nebo místě", "somatické zhoršení", "tlak na tajemství nebo trauma", "výrazné odpojení"],
      forbidden_directions: ["nevynucovat vzpomínky", "neinterpretovat kresbu jako diagnózu bez review", "neeskalovat trauma", "nepokračovat přes stop signál"],
      runtime_packet_seed: { source: "ui_fallback_until_next_briefing_regeneration" },
    },
    questions_for_hanka: ["Je pro tuto část dnes bezpečnější krátká Herna vedená Karlem po schválení terapeutkami, nebo má být Hanička poblíž jako fyzická opora?"],
    questions_for_kata: ["Vidíš u této části dnes riziko, kvůli kterému má být Herna jen stabilizační a ne hlubinně explorativní?"],
  };
};

const diagnosticText = (code?: string | null, status?: string | null): string => {
  if (code === "unauthorized_cron_call") return "Automatické ranní volání nebylo autorizované.";
  if (code === "cycle_running") return "Denní cyklus ještě běží.";
  if (code === "cycle_stuck") return "Denní cyklus zůstal viset a byl označen jako stale.";
  if (code === "cycle_failed") return "Denní cyklus skončil chybou.";
  if (code === "cycle_missing") return "Dnešní ranní denní cyklus nebyl nalezen.";
  if (status === "failed") return "Poslední pokus o vytvoření přehledu selhal.";
  if (status === "skipped") return "Poslední pokus byl přeskočen backendovým guardem.";
  return "Backend zatím neuložil dnešní přehled ani konkrétní dokončený pokus.";
};

const DidDailyBriefingPanel = ({ refreshTrigger, onOpenDeliberation }: Props) => {
  const navigate = useNavigate();
  const didThreads = useDidThreads();
  const [briefing, setBriefing] = useState<BriefingRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [openingItemId, setOpeningItemId] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<BriefingDiagnostic | null>(null);
  const [yesterdaySessionFallback, setYesterdaySessionFallback] = useState<YesterdayFallbackReview | null>(null);
  const [yesterdayPlayroomFallback, setYesterdayPlayroomFallback] = useState<YesterdayFallbackReview | null>(null);
  /**
   * THERAPIST-LED TRUTH PASS (2026-04-22) — Duplicity guard.
   * Set obsahuje názvy částí, pro které dnes existuje schválený
   * `did_daily_session_plans` (status='approved'). Pokud briefingem navržené
   * sezení směřuje na takovou část, briefing skryje "Návrh sezení k poradě"
   * a zobrazí pouze info, že plán je schválený a leží v Pracovna → Dnes.
   */
  const [approvedTodayParts, setApprovedTodayParts] = useState<Set<string>>(new Set());

  const loadApprovedToday = useCallback(async () => {
    try {
      const today = pragueTodayISO();
      const { data, error } = await supabase
        .from("did_daily_session_plans")
        .select("selected_part,status")
        .eq("plan_date", today)
        .eq("status", "approved");
      if (error) throw error;
      const set = new Set<string>(
        ((data ?? []) as Array<{ selected_part: string | null }>)
          .map((r) => (r.selected_part || "").trim())
          .filter((s) => s.length > 0),
      );
      setApprovedTodayParts(set);
    } catch (e) {
      console.error("[DidDailyBriefingPanel] loadApprovedToday failed:", e);
      setApprovedTodayParts(new Set());
    }
  }, []);

  const loadYesterdayFallback = useCallback(async () => {
    try {
      const yesterday = pragueYesterdayISO();
      const { data: reviews } = await (supabase as any)
        .from("did_session_reviews")
        .select("mode,part_name,status,clinical_summary,therapeutic_implications,team_implications,next_session_recommendation,evidence_limitations,clinical_findings,implications_for_part,implications_for_whole_system,recommendations_for_therapists,recommendations_for_next_session,recommendations_for_next_playroom,team_closing,drive_sync_status,source_of_truth_status,analysis_json")
        .eq("session_date", yesterday)
        .eq("is_current", true)
        .order("updated_at", { ascending: false })
        .limit(4);
      const rows = (reviews || []) as any[];
      const mapReview = (review: any): YesterdayFallbackReview => ({
        held: true,
        mode: review.mode === "playroom" ? "playroom" : "session",
        part_name: review.part_name || undefined,
        completion: review.status === "analyzed" ? "completed" : review.status === "partially_analyzed" ? "partial" : "abandoned",
        karel_summary: review.analysis_json?.practical_report_text || review.clinical_summary || review.evidence_limitations || "Review existuje, ale klinické shrnutí zatím není uložené.",
        key_finding_about_part: review.implications_for_part || review.therapeutic_implications || review.clinical_findings || "Závěr je omezen dostupnou evidencí.",
        implications_for_plan: review.mode === "playroom" ? (review.recommendations_for_next_playroom || review.next_session_recommendation) : (review.recommendations_for_next_session || review.next_session_recommendation) || "Doplnit chybějící podklady a navázat v dalším plánování.",
        team_acknowledgement: review.team_closing || review.team_implications || "Děkuji Haničce a Kátě za držení kontinuity; i částečný záznam je pro tým užitečný, když je označen poctivě.",
        practical_report: review.analysis_json?.practical_report_text || review.clinical_summary || null,
        detailed_analysis: review.analysis_json?.detailed_analysis_text || review.analysis_json?.diagnostic_validity || null,
        sync_status: review.source_of_truth_status || review.drive_sync_status || null,
        team_closing: review.team_closing || null,
        status_label: review.status,
      });
      const playroomReview = rows.find((r) => r.mode === "playroom");
      const sessionReview = rows.find((r) => r.mode !== "playroom");
      if (playroomReview) setYesterdayPlayroomFallback(mapReview(playroomReview));
      if (sessionReview) setYesterdaySessionFallback(mapReview(sessionReview));

      if (!playroomReview) {
        const dayStart = `${yesterday}T00:00:00.000Z`;
        const dayEnd = `${yesterday}T23:59:59.999Z`;
        const { data: playroomThread } = await (supabase as any)
          .from("did_threads")
          .select("id,part_name,thread_label,messages,last_activity_at,started_at,created_at")
          .eq("sub_mode", "karel_part_session")
          .gte("last_activity_at", dayStart)
          .lte("last_activity_at", dayEnd)
          .order("last_activity_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (playroomThread) {
          const messages = Array.isArray(playroomThread.messages) ? playroomThread.messages : [];
          const userTurns = messages.filter((m: any) => m?.role === "user").length;
          const assistantTurns = messages.filter((m: any) => m?.role === "assistant").length;
          setYesterdayPlayroomFallback({
            held: true,
            mode: "playroom",
            part_name: playroomThread.part_name || undefined,
            completion: userTurns > 0 ? "partial" : "abandoned",
            karel_summary: userTurns > 0
              ? `Včerejší herna proběhla ve vlákně „${playroomThread.thread_label || "Herna"}“. Vidím ${userTurns} odpovědí části a ${assistantTurns} Karlových vstupů. Plné klinické vyhodnocení zatím není uložené, proto ji zde označuji jako čekající na review, ne jako hotový závěr.`
              : `Včerejší herna byla otevřená jako „${playroomThread.thread_label || "Herna"}“, ale zatím nevidím odpověď části. Sekce zůstává viditelná, aby Herna nezmizela z přehledu.`,
            key_finding_about_part: "Zatím jde o provozní evidenci z Herny; klinický závěr musí vzniknout až z uloženého playroom review.",
            implications_for_plan: "Doplnit/obnovit vyhodnocení Herny jako samostatný playroom report, oddělený od terapeutického sezení.",
            team_acknowledgement: "Děkuji za udržení samostatné stopy Herny — nebude se míchat s programem sezení.",
            practical_report: null,
            detailed_analysis: null,
            sync_status: "čeká na playroom review",
            status_label: "pending_review",
          });
        } else {
          setYesterdayPlayroomFallback(null);
        }
      }

      // Playroom review nesmí zabránit samostatnému fallbacku pro Včerejší sezení.
      // Dřív jakýkoliv řádek v did_session_reviews (typicky mode='playroom') ukončil
      // funkci a terapeutické sezení tiše zmizelo z Karlova přehledu.
      if (sessionReview) return;
      const { data: plan } = await (supabase as any)
        .from("did_daily_session_plans")
        .select("id,selected_part,session_lead,therapist,status,lifecycle_status,plan_markdown")
        .eq("plan_date", yesterday)
        .not("urgency_breakdown->>ui_surface", "eq", "did_kids_playroom")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!plan) { setYesterdaySessionFallback(null); return; }
      const { data: progress } = await (supabase as any)
        .from("did_live_session_progress")
        .select("completed_blocks,total_blocks,items")
        .eq("plan_id", plan.id)
        .maybeSingle();
      const completed = progress?.completed_blocks ?? 0;
      const total = progress?.total_blocks ?? null;
      setYesterdaySessionFallback({
        held: true,
        mode: "session",
        part_name: plan.selected_part || undefined,
        lead: String(plan.session_lead || plan.therapist || "").toLowerCase().includes("kat") ? "Káťa" : "Hanička",
        completion: completed > 0 ? "partial" : "abandoned",
        karel_summary: completed > 0
          ? `Včerejší sezení má částečnou evidenci (${completed}${total ? `/${total}` : ""} bodů). Plné klinické review ještě není uložené, proto zatím nebudu předstírat hotový závěr.`
          : "Včera existoval plán sezení, ale zatím k němu nevidím dost průběhových podkladů pro plné klinické zhodnocení.",
        key_finding_about_part: "Stav je evidence-limited: sekce zůstává viditelná, ale závěr čeká na review nebo doplnění podkladů.",
        implications_for_plan: "Karel má sezení předat finalizační cestě; pokud podklady chybí, má vzniknout evidence-limited review místo tichého zmizení sekce.",
        team_acknowledgement: "Haničko a Káťo, děkuji za udržení rámce — i nedokončené sezení se teď poctivě označí a neztratí se z přehledu.",
        status_label: plan.lifecycle_status || plan.status,
      });
    } catch (e) {
      console.error("[DidDailyBriefingPanel] loadYesterdayFallback failed:", e);
      setYesterdaySessionFallback(null);
      setYesterdayPlayroomFallback(null);
    }
  }, []);

  const loadLatest = useCallback(async () => {
    setLoading(true);
    try {
      const today = pragueTodayISO();
      // P33.3 — fetch the latest 20 rows for today and let selectBestBriefing
      // pick the best valid full row. Backend may write fallback / sla_watchdog
      // rows newer than a fully-rendered briefing; the UI must NOT take the
      // newest blindly.
      const [{ data: todayRows, error }, { data: lastBriefing }, { data: lastAttempt }] = await Promise.all([
        supabase
          .from("did_daily_briefings")
          .select("*")
          .eq("is_stale", false)
          .eq("briefing_date", today)
          .order("generated_at", { ascending: false })
          .limit(20),
        supabase.from("did_daily_briefings").select("*").eq("is_stale", false).order("generated_at", { ascending: false }).limit(1).maybeSingle(),
        (supabase as any).from("did_daily_briefing_attempts").select("status,error_code,error_message,cycle_status,briefing_date,created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
      ]);

      if (error) throw error;
      const data = selectBestBriefing<any>(todayRows ?? []);
      setBriefing((data as unknown as BriefingRow) ?? ((lastBriefing as unknown as BriefingRow) ?? null));
      if (!data) {
        const code = (lastAttempt as any)?.error_code ?? null;
        const status = (lastAttempt as any)?.status ?? null;
        setDiagnostic({
          reason: diagnosticText(code, status),
          detail: (lastAttempt as any)?.error_message || ((lastAttempt as any)?.cycle_status ? `Stav denního cyklu: ${(lastAttempt as any).cycle_status}` : "Audit zatím nemá detail chyby."),
          lastBriefingDate: (lastBriefing as any)?.briefing_date ?? null,
          lastAttemptStatus: status,
          lastAttemptCode: code,
        });
      } else {
        setDiagnostic(null);
      }
    } catch (e) {
      console.error("[DidDailyBriefingPanel] load failed:", e);
      setBriefing(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLatest();
    loadApprovedToday();
    loadYesterdayFallback();
  }, [loadLatest, loadApprovedToday, loadYesterdayFallback, refreshTrigger]);

  // Auto-refresh při nově vygenerovaném briefingu i při doplnění včerejšího review,
  // aby sekce Včerejší herna naskočila bez ručního reloadu dashboardu.
  useEffect(() => {
    const channel = supabase
      .channel("did_daily_briefings_panel")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "did_daily_briefings" },
        () => {
          loadLatest();
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "did_daily_briefings" },
        () => {
          loadLatest();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "did_session_reviews" },
        () => {
          loadYesterdayFallback();
        },
      )
      .subscribe();

    const onFocus = () => {
      loadLatest();
      loadYesterdayFallback();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      window.removeEventListener("focus", onFocus);
      supabase.removeChannel(channel);
    };
  }, [loadLatest, loadYesterdayFallback]);

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke("karel-did-daily-briefing", {
        body: { method: "manual", force: true },
      });
      if (error) throw error;
      if (data?.briefing) {
        setBriefing(data.briefing);
        toast.success("Karlův přehled byl přegenerován.");
      } else {
        await loadLatest();
      }
    } catch (e: any) {
      console.error("[DidDailyBriefingPanel] regenerate failed:", e);
      toast.error(e?.message || "Generování briefingu selhalo.");
    } finally {
      setRegenerating(false);
    }
  };

  // ─── Navigation helpers (Slice 2 — kanonické persistentní targety) ───

  /**
   * Lazy-otevře nebo založí kanonický did_threads workspace pro briefing ask.
   * Druhý klik na stejný ask resolvne tentýž thread (workspace lookup).
   */
  const openAskWorkspace = useCallback(
    async (
      role: "ask_hanka" | "ask_kata",
      item: AskItemObj,
    ) => {
      if (openingItemId) return; // de-dup paralelní double-click
      setOpeningItemId(item.id);
      try {
        const subMode = role === "ask_hanka" ? "mamka" : "kata";
        const recipientName = role === "ask_hanka" ? "Hanička" : "Káťa";

        // 1) Try canonical workspace lookup
        const existing = await didThreads.getThreadByWorkspace(role, item.id);
        if (existing) {
          markBriefingOrigin();
          navigate(`/chat?workspace_thread=${existing.id}`);
          return;
        }

        // 2) Lazy-create with Karel's intro
        const intro = [
          `📝 **Pro ${recipientName}** — z dnešního přehledu`,
          "",
          item.text,
          "",
          `*Proč to potřebuji:* tento bod jsem dnes ráno pojmenoval jako podstatný pro další postup. Bez tvojí odpovědi pracuji se slepým místem.`,
          "",
          `*Jak na to:* odpověz prosím vlastními slovy. Pokud potřebuješ, klidně mi nejdřív polož zpřesňující otázku.`,
        ].join("\n");

        const thread = await didThreads.createThread(
          "Karel",
          subMode,
          "cs",
          [{ role: "assistant", content: intro }],
          {
            threadLabel: `Pro ${recipientName}: ${item.text.slice(0, 60)}`,
            workspaceType: role,
            workspaceId: item.id,
          },
        );
        if (!thread) {
          toast.error("Nepodařilo se otevřít vlákno.");
          return;
        }
        markBriefingOrigin();
        navigate(`/chat?workspace_thread=${thread.id}`);
      } catch (e: any) {
        console.error("[DidDailyBriefingPanel] openAskWorkspace failed:", e);
        toast.error(e?.message || "Nepodařilo se otevřít vlákno.");
      } finally {
        setOpeningItemId(null);
      }
    },
    [didThreads, navigate, openingItemId],
  );

  /**
   * Klik na decision → najde/vytvoří persistentní did_team_deliberation.
   *
   * SLICE 3 — idempotence je AUTORITATIVNĚ řešená serverem přes
   * `linked_briefing_item_id` (kanonický stabilní id briefing itemu).
   * Druhý klik na stejný `decisions[i]` vrátí EXISTUJÍCÍ poradu
   * (server odpoví `reused: true`). Žádný klientský fuzzy ilike-match.
   *
   * Legacy fallback: pokud briefing je stará verze bez `id` na decisions,
   * generujeme stabilní pseudo-id přes legacyAskIdFor (cache podle title).
   */
  const openDecisionDeliberation = useCallback(
    async (d: BriefingDecision) => {
      if (openingItemId || !briefing) return;
      const itemId = d.id || legacyAskIdFor(briefing.id, "ask_hanka", `decision::${d.title}`);
      setOpeningItemId(itemId);
      try {
        const { data, error } = await (supabase as any).functions.invoke(
          "karel-team-deliberation-create",
          {
            body: {
              deliberation_type: DECISION_TO_DELIB_TYPE[d.type] ?? "team_task",
              subject_parts: d.part_name ? [d.part_name] : [],
              reason: d.reason,
              hint: d.title,
              priority: d.type === "crisis" ? "crisis" : "normal",
              linked_briefing_id: briefing.id,
              linked_briefing_item_id: itemId,
            },
          },
        );
        if (error) throw error;
        const created = (data as any)?.deliberation;
        if (!created?.id) throw new Error("Porada nebyla vytvořena.");

        // 2026-04-19 — markBriefingOrigin patří POUZE do navigate-fallback
        // větve. V modal flow (onOpenDeliberation existuje) zůstává uživatel
        // na DID dashboardu — DeliberationRoom je Dialog, který zavírá
        // setOpenDeliberationId(null) → návrat je nativní, žádný flag netřeba.
        // Bez tohoto guardu by `karel_briefing_return="1"` zůstal viset
        // v sessionStorage a omylem ho zkonzumoval první další chat-view.
        if (onOpenDeliberation) {
          onOpenDeliberation(created.id);
        } else {
          markBriefingOrigin();
          navigate(`/chat?deliberation_id=${created.id}`);
        }
        if (!(data as any)?.reused) toast.success("Porada vytvořena.");
      } catch (e: any) {
        console.error("[DidDailyBriefingPanel] openDecisionDeliberation failed:", e);
        toast.error(e?.message || "Nepodařilo se otevřít poradu.");
      } finally {
        setOpeningItemId(null);
      }
    },
    [briefing, navigate, onOpenDeliberation, openingItemId],
  );

  /**
   * Klik na proposed_session → session-plan deliberation s plným prefillem.
   *
   * SLICE 3 — payload pro create obsahuje:
   *   - linked_briefing_id / linked_briefing_item_id (idempotence serverside)
   *   - prefill { initial_karel_brief, karel_proposed_plan, agenda_outline,
   *     questions_for_hanka, questions_for_kata } — server prefill preferuje
   *     před AI generací, takže obsah porady je deterministický a vychází
   *     z briefingu, ne z druhotné AI iterace.
   *
   * Při schválení (3 podpisy) bridguje karel-team-deliberation-signoff
   * do did_daily_session_plans.
   */
  const openProposedSessionDeliberation = useCallback(
    async (s: ProposedSession) => {
      if (openingItemId || !briefing) return;
      const itemId = s.id || legacyAskIdFor(briefing.id, "ask_hanka", `session::${s.part_name}`);
      setOpeningItemId(itemId);
      try {
        const titleHint = `Plán sezení s ${s.part_name}`;

        const reasonText = [
          s.why_today,
          s.kata_involvement ? `(Káťa: ${s.kata_involvement})` : "",
        ].filter(Boolean).join(" — ");

        // Prefill obsahu z briefingu — server ho použije přímo, místo AI re-generace.
        const introBrief = [
          `📅 **${titleHint}** (vede ${s.led_by}${s.duration_min ? `, ~${s.duration_min} min` : ""})`,
          "",
          `*Proč právě dnes:* ${s.why_today}`,
          s.kata_involvement ? `\n*Káťa:* ${s.kata_involvement}` : "",
          "",
          "Otevírám tuhle poradu, abychom prošli osnovu a doladili otázky před sezením.",
        ].filter(Boolean).join("\n");

        // Schválené session parametry — bridge do did_daily_session_plans je čte
        // autoritativně. Žádný hardcoded „hanka/individual“ na straně signoff.
        const sessionParams = {
          part_name: s.part_name,
          led_by: s.led_by,                                      // "Hanička"|"Káťa"|"společně"
          session_format: s.led_by === "společně" ? "joint" : "individual",
          duration_min: typeof s.duration_min === "number" ? s.duration_min : null,
          why_today: s.why_today ?? null,
          kata_involvement: s.kata_involvement ?? null,
          hybrid_contract: (s as any).hybrid_contract && typeof (s as any).hybrid_contract === "object"
            ? (s as any).hybrid_contract
            : null,
        };

        const prefill = {
          title: titleHint,
          reason: reasonText,
          initial_karel_brief: introBrief,
          karel_proposed_plan: s.first_draft,
          agenda_outline: Array.isArray(s.agenda_outline) ? s.agenda_outline : [],
          questions_for_hanka: Array.isArray(s.questions_for_hanka) ? s.questions_for_hanka : [],
          questions_for_kata: Array.isArray(s.questions_for_kata) ? s.questions_for_kata : [],
          session_params: sessionParams,
        };

        const { data, error } = await (supabase as any).functions.invoke(
          "karel-team-deliberation-create",
          {
            body: {
              deliberation_type: "session_plan",
              subject_parts: [s.part_name],
              reason: reasonText,
              hint: titleHint,
              priority: "high",
              linked_briefing_id: briefing.id,
              linked_briefing_item_id: itemId,
              prefill,
            },
          },
        );
        if (error) throw error;
        const created = (data as any)?.deliberation;
        if (!created?.id) throw new Error("Plán sezení nebyl vytvořen.");

        // Stejný guard jako u openDecisionDeliberation: markBriefingOrigin
        // patří jen do navigate-fallback větve. Modal flow zavírá Dialog
        // nativně přes setOpenDeliberationId(null) — žádný flag netřeba.
        // Bez tohoto guardu zůstane "karel_briefing_return"='1' viset
        // a první další chat-view (typicky další ask_hanka klik) ho omylem
        // zkonzumuje a hodí uživatele zpět na dashboard místo do vlákna.
        if (onOpenDeliberation) {
          onOpenDeliberation(created.id);
        } else {
          markBriefingOrigin();
          navigate(`/chat?deliberation_id=${created.id}`);
        }
        if (!(data as any)?.reused) toast.success("Plán sezení otevřen jako porada týmu.");
      } catch (e: any) {
        console.error("[DidDailyBriefingPanel] openProposedSessionDeliberation failed:", e);
        toast.error(e?.message || "Nepodařilo se otevřít plán sezení.");
      } finally {
        setOpeningItemId(null);
      }
    },
    [briefing, navigate, onOpenDeliberation, openingItemId],
  );

  const openProposedPlayroomDeliberation = useCallback(
    async (s: ProposedPlayroom) => {
      if (openingItemId || !briefing) return;
      const itemId = s.id || legacyAskIdFor(briefing.id, "ask_kata", `playroom::${s.part_name}`);
      setOpeningItemId(itemId);
      try {
        const titleHint = `Plán dnešní herny s ${s.part_name}`;
        const program = Array.isArray(s.playroom_plan?.therapeutic_program) ? s.playroom_plan.therapeutic_program : [];
        const reasonText = [s.main_theme, s.why_this_part_today].filter(Boolean).join(" — ");
        const introBrief = [
          `🎲 **${titleHint}**`,
          "",
          `*Hlavní téma:* ${s.main_theme}`,
          `*Proč právě dnes:* ${s.why_this_part_today}`,
          "",
          "Otevírám poradu ke schválení samostatného programu Herny. Herna má svůj vlastní bezpečný herní program. Karel ji může vést až po schválení Haničkou a Káťou.",
        ].join("\n");
        const karelPlan = [
          `Část: ${s.part_name}`,
          `Stav: ${s.status || "awaiting_therapist_review"}`,
          `Hlavní téma: ${s.main_theme}`,
          "",
          `Proč právě tato herna:\n${s.why_this_part_today}`,
          "",
          s.goals?.length ? `Cíle dnešní herny:\n${s.goals.map((g, i) => `${i + 1}. ${g}`).join("\n")}` : "",
          "",
          s.playroom_plan?.child_safe_version ? `Dětsky bezpečná verze programu:\n${s.playroom_plan.child_safe_version}` : "",
          "",
          s.playroom_plan?.risks_and_stop_signals?.length ? `Rizika a stop signály:\n${s.playroom_plan.risks_and_stop_signals.map((x) => `- ${x}`).join("\n")}` : "",
          "",
          s.playroom_plan?.forbidden_directions?.length ? `Zakázané směry:\n${s.playroom_plan.forbidden_directions.map((x) => `- ${x}`).join("\n")}` : "",
        ].filter(Boolean).join("\n");
        const prefill = {
          title: titleHint,
          reason: reasonText,
          initial_karel_brief: introBrief,
          karel_proposed_plan: karelPlan,
          agenda_outline: program,
          questions_for_hanka: Array.isArray(s.questions_for_hanka) ? s.questions_for_hanka : [],
          questions_for_kata: Array.isArray(s.questions_for_kata) ? s.questions_for_kata : [],
          session_params: {
            part_name: s.part_name,
            led_by: "Karel",
            session_format: "playroom",
            why_today: s.why_this_part_today,
            session_mode: "playroom",
            session_actor: "karel_direct",
            ui_surface: "did_kids_playroom",
            approved_for_child_session: false,
            human_review_required: true,
            review_state: s.status || "awaiting_therapist_review",
            playroom_plan: s.playroom_plan,
          },
        };
        const { data, error } = await (supabase as any).functions.invoke("karel-team-deliberation-create", {
          body: {
            deliberation_type: "session_plan",
            subject_parts: [s.part_name],
            reason: reasonText,
            hint: titleHint,
            priority: "high",
            linked_briefing_id: briefing.id,
            linked_briefing_item_id: itemId,
            prefill,
          },
        });
        if (error) throw error;
        const created = (data as any)?.deliberation;
        if (!created?.id) throw new Error("Plán herny nebyl vytvořen.");
        if (onOpenDeliberation) onOpenDeliberation(created.id);
        else { markBriefingOrigin(); navigate(`/chat?deliberation_id=${created.id}`); }
        if (!(data as any)?.reused) toast.success("Návrh herny otevřen jako porada týmu.");
      } catch (e: any) {
        console.error("[DidDailyBriefingPanel] openProposedPlayroomDeliberation failed:", e);
        toast.error(e?.message || "Nepodařilo se otevřít návrh herny.");
      } finally {
        setOpeningItemId(null);
      }
    },
    [briefing, navigate, onOpenDeliberation, openingItemId],
  );

  const openProgramAskDeliberation = useCallback(
    async (role: "ask_hanka" | "ask_kata", item: AskItemObj) => {
      if (!briefing) return false;
      if (item.target_type === "proposed_session" && briefing.payload.proposed_session) {
        const session = {
          ...briefing.payload.proposed_session,
          id: item.target_item_id || briefing.payload.proposed_session.id,
          questions_for_hanka: role === "ask_hanka" ? [item.text] : (briefing.payload.proposed_session.questions_for_hanka ?? []),
          questions_for_kata: role === "ask_kata" ? [item.text] : (briefing.payload.proposed_session.questions_for_kata ?? []),
        };
        await openProposedSessionDeliberation(session);
        toast.info("Otázka je napojená na plán Sezení a otevřela se v poradě.");
        return true;
      }

      if (item.target_type === "proposed_playroom" && briefing.payload.proposed_playroom) {
        const playroom = {
          ...briefing.payload.proposed_playroom,
          id: item.target_item_id || briefing.payload.proposed_playroom.id,
          questions_for_hanka: role === "ask_hanka" ? [item.text] : (briefing.payload.proposed_playroom.questions_for_hanka ?? []),
          questions_for_kata: role === "ask_kata" ? [item.text] : (briefing.payload.proposed_playroom.questions_for_kata ?? []),
        };
        await openProposedPlayroomDeliberation(playroom);
        toast.info("Otázka je napojená na program Herny a otevřela se v poradě.");
        return true;
      }

      return false;
    },
    [briefing, openProposedPlayroomDeliberation, openProposedSessionDeliberation],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!briefing) {
    return (
      <div className="space-y-3 p-4 rounded-xl border border-dashed border-border/60 bg-card/30">
        <div className="flex items-start gap-2">
          <Sparkles className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm text-foreground/80">
              Dnešní Karlův přehled zatím nevznikl.
            </p>
            <p className="text-[12px] text-muted-foreground mt-1">
              {diagnostic?.reason ?? "Zjišťuji poslední backendový stav."}
            </p>
            {diagnostic?.detail && (
              <p className="mt-1 text-[11px] text-muted-foreground/90">{diagnostic.detail}</p>
            )}
            {diagnostic?.lastBriefingDate && diagnostic.lastBriefingDate !== pragueTodayISO() && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Poslední dostupný přehled: {formatDate(diagnostic.lastBriefingDate)}
              </p>
            )}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleRegenerate}
          disabled={regenerating}
          className="text-[12px]"
        >
          {regenerating ? (
            <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
          ) : (
            <Sparkles className="w-3 h-3 mr-1.5" />
          )}
          Přegenerovat dnešní přehled
        </Button>
      </div>
    );
  }

  const p = briefing.payload;
  const yesterdayReview = (p.yesterday_session_review && p.yesterday_session_review.exists)
    ? {
        ...p.yesterday_session_review,
        karel_summary: p.yesterday_session_review.practical_report_text || p.yesterday_session_review.karel_summary,
        team_acknowledgement: p.yesterday_session_review.team_closing_text || p.yesterday_session_review.team_acknowledgement,
        practical_report: p.yesterday_session_review.practical_report_text || p.yesterday_session_review.karel_summary,
        detailed_analysis: p.yesterday_session_review.detailed_analysis_text,
        team_closing: p.yesterday_session_review.team_closing_text,
        status_label: p.yesterday_session_review.status,
      } as YesterdayFallbackReview
    : yesterdaySessionFallback;
  const backendPlayroom = p.yesterday_playroom_review?.exists ? p.yesterday_playroom_review : null;
  const yesterdayPlayroomReview = backendPlayroom ? {
    held: true,
    mode: "playroom" as const,
    part_name: backendPlayroom.part_name || undefined,
    completion: backendPlayroom.status === "analyzed" ? "completed" as const : backendPlayroom.status === "partially_analyzed" ? "partial" as const : "abandoned" as const,
    karel_summary: backendPlayroom.practical_report_text || backendPlayroom.fallback_reason || "Herna je evidovaná, ale praktický report zatím není hotový.",
    key_finding_about_part: backendPlayroom.implications_for_part || "Význam pro část zatím čeká na playroom review.",
    implications_for_plan: backendPlayroom.recommendations_for_next_playroom || "Další Herna má navázat až po dokončení review.",
    team_acknowledgement: backendPlayroom.recommendations_for_therapists || "Karel drží Hernu odděleně od terapeutického sezení.",
    practical_report: backendPlayroom.practical_report_text || null,
    detailed_analysis: backendPlayroom.detailed_analysis_text || null,
    sync_status: backendPlayroom.drive_sync_status || backendPlayroom.status || null,
    status_label: backendPlayroom.status,
    implications_for_system: backendPlayroom.implications_for_system,
    recommendations_for_therapists: backendPlayroom.recommendations_for_therapists,
    recommendations_for_next_session: backendPlayroom.recommendations_for_next_session,
    detail_analysis_drive_url: backendPlayroom.detail_analysis_drive_url,
    practical_report_drive_url: backendPlayroom.practical_report_drive_url,
  } as YesterdayFallbackReview & Record<string, any> : yesterdayPlayroomFallback;
  const yesterdaySessionVisible = true;
  const hasProposed = !!p.proposed_session?.part_name;
  const proposedPartName = (p.proposed_session?.part_name ?? "").trim();
  const proposedAlreadyApproved =
    proposedPartName.length > 0 && approvedTodayParts.has(proposedPartName);
  const playroomProposal = p.proposed_playroom?.part_name
    ? p.proposed_playroom
    : createFallbackPlayroomProposal(p);
  // ── KALENDÁŘNÍ INTEGRITA: viewer-side revalidace ──
  // Cached briefing může být zafrozený z dřívějšího dne (např. user otevřel
  // dashboard ráno po půlnoci a vidí včerejší briefing). Recency MUSÍME
  // přepočítat proti aktuálnímu Europe/Prague datu, jinak text bude tvrdit
  // „Včerejší Herna" i pro herní materiál starý 2+ dny.
  const viewerToday = pragueTodayIso();
  const freshnessMeta = getBriefingFreshnessMeta(briefing.briefing_date, viewerToday);
  const briefingDateIso = freshnessMeta.briefing_date ?? String(briefing.briefing_date ?? "").slice(0, 10);
  // P12: isCurrentBriefing / daysSinceBriefing / staleBannerText replaced
  // by the deterministic getBriefingTruthStatus() below — never trust
  // calendar freshness alone (today + limited still must NOT show "Aktuální").
  const rawPlayRecency = ((p as any).recent_playroom_review ?? p.yesterday_playroom_review) as RecencyMeta | null | undefined;
  const rawSessRecency = ((p as any).recent_session_review ?? p.yesterday_session_review) as RecencyMeta | null | undefined;
  const playRecency = revalidateRecencyForViewer(rawPlayRecency, viewerToday, "playroom");
  const sessRecency = revalidateRecencyForViewer(rawSessRecency, viewerToday, "session");
  const sessionView = toProposedSessionView(p.proposed_session);
  const playroomView = toProposedPlayroomView(playroomProposal);
  const decisions = (p.decisions ?? []).slice(0, 3);
  const hankaItems = (p.ask_hanka ?? []).map((raw) => toAskItem(raw, briefing.id, "ask_hanka"));
  const kataItems = (p.ask_kata ?? []).map((raw) => toAskItem(raw, briefing.id, "ask_kata"));
  const legacyTechnicalGreeting = /těžk[áa]\s+syntéza|fallback|bezpečn[ýy]\s+režim/i.test(p.greeting || "");
  const openingMonologueText = ensureKarelOpeningVoice(p.opening_monologue_text || p.opening_monologue?.opening_monologue_text || (legacyTechnicalGreeting ? "Dobré ráno, Haničko a Káťo. Dnes držme hlavně klinickou návaznost, opatrnost v závěrech a jeden bezpečný další krok pro kluky. Budu rozlišovat, co víme jistě, co je pracovní hypotéza a co ještě čeká na ověření." : p.greeting) || "", playRecency, sessRecency);
  const technicalNote = (p.technical_note || p.opening_monologue?.technical_note || "").trim();
  const visibleRealityContext = realityContextText(p);
  const sessionContextSummary = backendContextSummary(p.proposed_session?.backend_context_inputs);
  const playroomContextSummary = backendContextSummary(playroomProposal?.backend_context_inputs);
  const playroomSectionTitle = playRecency?.exists
    ? (playRecency.is_yesterday ? "Včerejší herna" : ((playRecency.visible_label || `Poslední Herna (${formatPragueDateLabel(playRecency.source_date_iso ?? playRecency.session_date_iso)})`).replace("Herna", "herna")))
    : "Včerejší herna";
  const sessionSectionTitle = sessRecency?.exists
    ? (sessRecency.is_yesterday ? "Včerejší sezení" : ((sessRecency.visible_label || `Poslední Sezení (${formatPragueDateLabel(sessRecency.source_date_iso ?? sessRecency.session_date_iso)})`).replace("Sezení", "sezení")))
    : "Včerejší sezení";
  const playroomRecencyBadge = playRecency?.exists && !playRecency.is_yesterday
    ? `${playRecency.human_recency_label || "starší"} · ${formatPragueDateLabel(playRecency.source_date_iso ?? playRecency.session_date_iso)}`
    : null;
  const sessionRecencyBadge = sessRecency?.exists && !sessRecency.is_yesterday
    ? `${sessRecency.human_recency_label || "starší"} · ${formatPragueDateLabel(sessRecency.source_date_iso ?? sessRecency.session_date_iso)}`
    : null;
  const sanitizeProse = (v: unknown) => humanizeRecencyInProse(cleanVisibleClinicalText(v), playRecency, sessRecency);

  // P12: deterministic truth-status — single source for badge + banner.
  // Replaces the old `briefingMethodBadge` + freshness banner + limited
  // banner trio that could produce contradictions like
  // "Aktuální (SLA záplata)" + "starý přehled" + "Dnešní přehled zatím nevznikl".
  const truthRaw = getBriefingTruthStatus(
    {
      briefing_date: briefing.briefing_date,
      is_stale: briefing.is_stale,
      generation_method: (briefing as any).generation_method ?? null,
      generation_duration_ms: (briefing as any).generation_duration_ms ?? null,
      payload: {
        limited: (p as any).limited,
        limited_reason: (p as any).limited_reason,
        daily_cycle_status: (p as any).daily_cycle_status,
      },
    },
    viewerToday,
  );
  // P33.3 — when the actual row is a full renderable briefing (truth-gated,
  // human_ok, 9 sections, clean audit), the UI must NOT show "Náhradní omezený"
  // or "Ruční přehled" badge/banner just because of generation_method label.
  const isFullRenderable = isFullRenderableBriefing(briefing as any);
  const truth = isFullRenderable
    ? {
        ...truthRaw,
        level: "fresh_full" as const,
        badgeLabel: "Aktuální",
        bannerText: null,
        canShowCurrent: true,
        detail: { ...truthRaw.detail, isLimited: false, isManual: false },
      }
    : truthRaw;
  const truthBadgeTone =
    truth.level === "fresh_full"
      ? "border-primary/30 text-primary/80"
      : truth.level === "stale_previous"
      ? "border-border text-muted-foreground"
      : "border-amber-500/40 text-amber-700 dark:text-amber-400";
  const truthBannerTone =
    truth.level === "fresh_full"
      ? "border-primary/20 bg-primary/5"
      : "border-amber-500/30 bg-amber-500/5";
  const daysAgoLabel =
    !truth.detail.isToday && truth.detail.daysSince > 0
      ? pluralizeDays(truth.detail.daysSince)
      : null;

  return (
    <div className="space-y-1">
      <ExternalLoadWarning />
      {/* Header — datum + meta + refresh */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-primary/70" />
          <div>
            <h2 className="text-sm font-medium text-foreground">Karlův přehled</h2>
            <p className="text-[11px] text-muted-foreground">
              {formatDate(briefing.briefing_date)}
              {daysAgoLabel && (
                <span className="ml-1 text-muted-foreground">· před {daysAgoLabel}</span>
              )}
            </p>
          </div>
          <Badge
            variant="outline"
            className={"ml-1 text-[10px] font-medium " + truthBadgeTone}
            data-testid="briefing-truth-badge"
            data-truth-level={truth.level}
            data-can-show-current={String(truth.canShowCurrent)}
          >
            {truth.badgeLabel}
          </Badge>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={handleRegenerate}
          disabled={regenerating}
          className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {regenerating ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3 mr-1" />
          )}
          Přegenerovat
        </Button>
      </div>

      {truth.bannerText && (
        <div
          className={`mb-3 rounded-lg border ${truthBannerTone} px-3 py-2 text-[12px] leading-relaxed text-foreground/85`}
          data-testid="briefing-truth-banner"
          data-truth-level={truth.level}
          data-viewer-date={viewerToday}
          data-briefing-date={briefingDateIso || undefined}
          data-days-since-briefing={String(truth.detail.daysSince)}
        >
          {truth.bannerText}
        </div>
      )}


      {/* P31.1b — když je k dispozici truth-locked human voice (ok=true),
          je primární vrstvou. Strukturovaný payload se schová do
          collapsed "Technické podklady", aby nevznikla duplicita.
          Když ok=false, ukáže se fallback warning a strukturovaný layout
          zůstává primární. Když chybí úplně, chová se jako dřív. */}
      {(() => {
        const hb: any = (p as any).karel_human_briefing;
        const humanOk = !!(hb && hb.ok === true && Array.isArray(hb.sections) && hb.sections.length > 0);
        const humanBroken = !!(hb && hb.ok === false);
        if (humanOk) {
          return (
            <div
              className="rounded-xl border border-primary/15 bg-card/30 p-3.5 mt-1 space-y-3"
              data-testid="karel-human-briefing"
              data-human-ok="true"
              data-renderer-version={hb.renderer_version}
            >
              {hb.sections.map((s: any, idx: number) => {
                const text = typeof s?.karel_text === "string" ? s.karel_text : "";
                if (!text.trim()) return null;
                return (
                  <div key={s?.section_id || idx} className="space-y-1">
                    {s?.title && (
                      <h3 className="text-[12px] font-medium text-foreground/70 uppercase tracking-wide">
                        {s.title}
                      </h3>
                    )}
                    <p className="text-[13px] leading-relaxed text-foreground/85 whitespace-pre-line">
                      {text}
                    </p>
                  </div>
                );
              })}
              {technicalNote && (
                <p className="pt-2 border-t border-border/40 text-[11px] leading-relaxed text-muted-foreground italic">
                  Technická poznámka: {technicalNote}
                </p>
              )}
            </div>
          );
        }
        // strukturovaný režim — humanOk = false nebo chybí
        return (
          <>
            {humanBroken && (
              <p
                className="mt-1 mb-2 text-[11px] italic text-muted-foreground"
                data-testid="karel-human-briefing-fallback"
                data-human-ok="false"
              >
                Humanizovaná vrstva není dostupná; zobrazuji strukturovaný přehled.
              </p>
            )}
            {/* 1. Karlův ranní terapeutický monolog (strukturovaný režim) */}
            <div className="rounded-xl border border-primary/15 bg-card/35 p-3.5 space-y-2">
              <p className="text-[14px] leading-relaxed text-foreground/90 whitespace-pre-line">
                {openingMonologueText}
              </p>
              {technicalNote && (
                <p className="pt-2 border-t border-border/40 text-[11px] leading-relaxed text-muted-foreground italic">
                  Technická poznámka: {technicalNote}
                </p>
              )}
            </div>
          </>
        );
      })()}

      {/* Strukturované sekce — primární jen když není human ok=true.
          Když je human vrstva primární, ukazujeme jen jako "Technické
          podklady" toggle, který odkrývá strukturovaný layout. */}
      {(() => {
        const hb: any = (p as any).karel_human_briefing;
        const humanPrimary = !!(hb && hb.ok === true && Array.isArray(hb.sections) && hb.sections.length > 0);
        if (!humanPrimary) return null;
        return (
          <details
            className="mt-2 rounded-md border border-border/40 bg-muted/10"
            data-testid="briefing-structured-collapsed"
          >
            <summary className="cursor-pointer px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground">
              Technické podklady
            </summary>
            <p className="px-3 py-2 text-[11px] text-muted-foreground italic">
              Strukturovaný přehled je dostupný v Pracovně (porady, plán dne, otázky terapeutek). Karlův přehled výše je primární vrstva.
            </p>
          </details>
        );
      })()}

      {/* P31.2C — read-only AI polish canary preview, collapsed audit panel.
          Hlavní text Karlova přehledu zůstává deterministic. */}
      <AiPolishCanaryPreviewPanel
        briefingId={briefing?.id || null}
        humanOk={!!((p as any).karel_human_briefing?.ok === true)}
      />


      {!((p as any).karel_human_briefing?.ok === true) && visibleRealityContext && (
        <>
          <NarrativeDivider />
          <SectionHead>Důležitý kontext z posledních dní</SectionHead>
          <div className="mt-2 rounded-lg border border-border/60 bg-card/40 p-3">
            <p className="text-[13px] leading-relaxed text-foreground/85 whitespace-pre-line">{visibleRealityContext}</p>
          </div>
        </>
      )}

      {!((p as any).karel_human_briefing?.ok === true) && (<>
      {/* 2. Co se změnilo za poslední 3 dny */}
      {p.last_3_days && (
        <>
          <NarrativeDivider />
          <SectionHead>Za poslední tři dny</SectionHead>
          <p className="text-[13px] leading-relaxed text-foreground/80 mt-2 whitespace-pre-line">
            {cleanVisibleClinicalText(p.last_3_days)}
          </p>
        </>
      )}

      {/* 3. Co zůstává významné z dřívějška */}
      {p.lingering && (
        <>
          <NarrativeDivider />
          <SectionHead>Z dřívějška zůstává podstatné</SectionHead>
          <p className="text-[13px] leading-relaxed text-foreground/80 mt-2 whitespace-pre-line">
            {p.lingering}
          </p>
        </>
      )}

      {p.daily_therapeutic_priority && (
        <>
          <NarrativeDivider />
          <SectionHead>Dnešní terapeutická priorita</SectionHead>
          <p className="text-[13px] leading-relaxed text-foreground/85 mt-2 whitespace-pre-line">
            {cleanVisibleClinicalText(p.daily_therapeutic_priority)}
          </p>
        </>
      )}

      {/* 3.5 Včerejší herna — samostatná vyhrazená sekce, nikdy nesmí splývat se sezením */}
      {yesterdayPlayroomReview && yesterdayPlayroomReview.held && (
        <>
          <NarrativeDivider />
          <SectionHead icon={<Sparkles className="w-3.5 h-3.5 text-primary/70" />}>
            {playroomSectionTitle}
          </SectionHead>
          <div className="mt-2 rounded-lg border border-border/60 bg-card/40 p-3 space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              {yesterdayPlayroomReview.part_name && <Badge className="text-[10px] h-5 px-2 bg-primary/15 text-primary border-primary/30">{yesterdayPlayroomReview.part_name}</Badge>}
              <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">vedl Karel</Badge>
              {playroomRecencyBadge && <Badge className="text-[10px] h-5 px-2 bg-amber-100/50 text-amber-900 border-amber-300/50">{playroomRecencyBadge}</Badge>}
              {yesterdayPlayroomReview.sync_status && <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">{yesterdayPlayroomReview.sync_status}</Badge>}
            </div>
            {playRecency?.exists && !playRecency.is_yesterday && (
              <p className="text-[12px] leading-relaxed text-amber-900/80 italic">
                {recencySectionNoticeText("playroom", playRecency, yesterdayPlayroomReview.part_name)}
              </p>
            )}
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Praktický report</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-foreground/85 whitespace-pre-line">{sanitizeProse(yesterdayPlayroomReview.practical_report || yesterdayPlayroomReview.karel_summary)}</p>
            </div>
            {yesterdayPlayroomReview.key_finding_about_part && <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Význam pro část</p><p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">{sanitizeProse(yesterdayPlayroomReview.key_finding_about_part)}</p></div>}
            {(yesterdayPlayroomReview as any).implications_for_system && <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Význam pro kluky jako celek</p><p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">{sanitizeProse((yesterdayPlayroomReview as any).implications_for_system)}</p></div>}
            {(yesterdayPlayroomReview as any).recommendations_for_therapists && <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Doporučení pro terapeutky</p><p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">{sanitizeProse((yesterdayPlayroomReview as any).recommendations_for_therapists)}</p></div>}
            {yesterdayPlayroomReview.implications_for_plan && <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Doporučení pro další hernu</p><p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">{sanitizeProse(yesterdayPlayroomReview.implications_for_plan)}</p></div>}
            {(yesterdayPlayroomReview as any).recommendations_for_next_session && <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Doporučení pro další sezení</p><p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">{sanitizeProse((yesterdayPlayroomReview as any).recommendations_for_next_session)}</p></div>}
            {(yesterdayPlayroomReview as any).spiritual_symbolics_safety_frame && <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Bezpečné rámování duchovní symboliky</p><p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">{sanitizeProse((yesterdayPlayroomReview as any).spiritual_symbolics_safety_frame)}</p></div>}
            {((yesterdayPlayroomReview as any).detail_analysis_drive_url || (yesterdayPlayroomReview as any).practical_report_drive_url) && <p className="text-[11px] text-muted-foreground">Drive: {(yesterdayPlayroomReview as any).detail_analysis_drive_url ? "detailní analýza uložena" : "detail čeká"} · {(yesterdayPlayroomReview as any).practical_report_drive_url ? "praktický report uložen" : "report čeká"}</p>}
            {yesterdayPlayroomReview.detailed_analysis && (
              <details className="rounded-md border border-border/50 bg-background/35 p-2">
                <summary className="cursor-pointer text-[12px] font-medium text-primary">Přečíst si detailní analýzu z {playRecency?.exists && !playRecency.is_yesterday ? `Herny ${formatPragueDateLabel(playRecency.session_date_iso)}` : "včerejší herny"}</summary>
                <p className="mt-2 text-[12px] leading-relaxed text-foreground/75 whitespace-pre-line">{sanitizeProse(yesterdayPlayroomReview.detailed_analysis)}</p>
              </details>
            )}
          </div>
        </>
      )}

      {/* 3.6 Včerejší sezení — samostatná vyhrazená sekce, nikdy nesmí splývat s Hernou */}
      {yesterdaySessionVisible && (
        <>
          <NarrativeDivider />
          <SectionHead icon={<Users className="w-3.5 h-3.5 text-primary/70" />}>
            {yesterdayReview?.held === false ? "Plánované Sezení, které klinicky neproběhlo" : sessionSectionTitle}
          </SectionHead>
          <div className="mt-2 p-3 rounded-lg border border-border/60 bg-card/40 space-y-2">
            {yesterdayReview && yesterdayReview.exists ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  {yesterdayReview.part_name && (
                    <Badge className="text-[10px] h-5 px-2 bg-primary/15 text-primary border-primary/30">
                      {yesterdayReview.part_name}
                    </Badge>
                  )}
                  {yesterdayReview.lead && (
                    <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">
                      vedla {yesterdayReview.lead}
                    </Badge>
                  )}
                  {yesterdayReview.completion && (
                    <Badge
                      className={`text-[10px] h-5 px-2 border ${
                        yesterdayReview.held === false
                          ? "bg-muted text-muted-foreground border-border"
                          : yesterdayReview.completion === "completed"
                          ? "bg-emerald-500/15 text-emerald-700 border-emerald-500/30"
                          : yesterdayReview.completion === "partial"
                          ? "bg-amber-500/15 text-amber-700 border-amber-500/30"
                          : "bg-destructive/15 text-destructive border-destructive/30"
                      }`}
                    >
                      {yesterdayReview.held === false
                        ? (yesterdayReview.status === "technical_test" ? "Technický test" : "Neuskutečněno")
                        : yesterdayReview.completion === "completed"
                        ? "Dokončeno"
                        : yesterdayReview.completion === "partial"
                        ? "Částečně"
                        : "Nedokončeno"}
                    </Badge>
                  )}
                  {sessionRecencyBadge && (
                    <Badge className="text-[10px] h-5 px-2 bg-amber-100/50 text-amber-900 border-amber-300/50">{sessionRecencyBadge}</Badge>
                  )}
                </div>
                {sessRecency?.exists && !sessRecency.is_yesterday && (
                  <p className="text-[12px] leading-relaxed text-amber-900/80 italic">
                    {sessRecency.not_yesterday_notice || "Včera Sezení neproběhlo."} {sessRecency.visible_sentence_prefix || ""}
                  </p>
                )}
                {yesterdayReview.karel_summary ? (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Karlovo vyhodnocení</p>
                    <p className="text-[13px] leading-relaxed text-foreground/85 whitespace-pre-line">
                      {sanitizeProse(yesterdayReview.karel_summary)}
                    </p>
                  </div>
                ) : (
                  <div className="text-[12px] italic text-muted-foreground">
                    Karlovo přetlumočení se právě dogeneruvává. Pokud se neobjeví do minuty, klikni „Přegenerovat".
                  </div>
                )}
                {yesterdayReview.key_finding_about_part && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Co teď víme o části</p>
                    <p className="text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line mt-0.5">
                      {cleanVisibleClinicalText(yesterdayReview.key_finding_about_part)}
                    </p>
                  </div>
                )}
                {yesterdayReview.implications_for_plan && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Co z toho plyne pro plán</p>
                    <p className="text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line mt-0.5">
                      {cleanVisibleClinicalText(yesterdayReview.implications_for_plan)}
                    </p>
                  </div>
                )}
                {yesterdayReview.team_acknowledgement && (
                  <div className="pt-1 border-t border-border/40">
                    <p className="text-[11px] uppercase tracking-wide text-primary/70">Týmové uzavření</p>
                    <p className="text-[12px] leading-relaxed text-foreground/85 italic whitespace-pre-line mt-0.5">
                      {cleanVisibleClinicalText(yesterdayReview.team_acknowledgement)}
                    </p>
                  </div>
                )}
                {(yesterdayReview as YesterdayFallbackReview).detailed_analysis && (
                  <details className="rounded-md border border-border/50 bg-background/35 p-2">
                    <summary className="cursor-pointer text-[12px] font-medium text-primary">Přečíst si detailní analýzu ze včerejšího sezení</summary>
                    <p className="mt-2 text-[12px] leading-relaxed text-foreground/75 whitespace-pre-line">{cleanVisibleClinicalText((yesterdayReview as YesterdayFallbackReview).detailed_analysis)}</p>
                  </details>
                )}
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">evidence zatím chybí</Badge>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Faktický stav</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">
                    Samostatná stopa včerejšího terapeutického sezení zatím není v Karlově přehledu dohledaná. Sekce zůstává viditelná schválně, aby se Včerejší sezení nikdy neztratilo za Hernou ani za prázdným briefing payloadem.
                  </p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Další krok</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">
                    Karel má dohledat nebo doplnit klinické dovyhodnocení sezení odděleně od vyhodnocení Herny; Herna nesmí být použita jako náhrada terapeutického sezení.
                  </p>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* 4. Dnešní navržené sezení — klikatelné.
          THERAPIST-LED TRUTH PASS (2026-04-22): Tato sekce zobrazuje POUZE
          první návrh sezení a CTA "Otevřít poradu". Pokud je porada už
          schválená (status='approved' nebo existuje plan v
          did_daily_session_plans), schová se — autoritativní zdroj je
          v Pracovna → Dnes → "Plán dnešního sezení". */}
      {hasProposed && p.proposed_session && sessionView && !proposedAlreadyApproved && (
        <>
          <NarrativeDivider />
          <SectionHead icon={<Sparkles className="w-3.5 h-3.5 text-primary" />}>
            {p.proposed_session.carry_over_reason === "unheld_yesterday_session" ? "Carry-over z neuskutečněného Sezení" : "Návrh sezení k poradě"}
          </SectionHead>
          <button
            type="button"
            onClick={() => openProposedSessionDeliberation(p.proposed_session!)}
            className="mt-2 w-full text-left p-3 rounded-lg border border-primary/20 bg-primary/5 hover:bg-primary/10 transition-colors space-y-2 cursor-pointer"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <Badge className="text-[10px] h-5 px-2 bg-primary/15 text-primary border-primary/30">
                {sessionView.part_name}
              </Badge>
              <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">
                vede {sessionView.lead}
              </Badge>
              <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">
                Karel asistuje
              </Badge>
              {p.proposed_session.duration_min && (
                <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">
                  {sessionView.duration}
                </Badge>
              )}
              {p.proposed_session.carry_over_reason === "unheld_yesterday_session" && (
                <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">
                  carry-over
                </Badge>
              )}
              <ArrowRight className="w-3.5 h-3.5 text-primary/60 ml-auto" />
            </div>
            <p className="text-[13px] leading-relaxed text-foreground/85 whitespace-pre-line">
              {sessionView.rationale}
            </p>
            <p className="text-[12px] leading-relaxed text-primary/80 italic">{sessionView.status_label}</p>
            {sessionView.blocks.length > 0 ? (
              <ol className="space-y-1.5 text-[13px] leading-relaxed text-foreground/80">
                {sessionView.blocks.map((block, index) => (
                  <li key={`${block.title}-${index}`}>
                    <span className="font-medium text-foreground/90">{index + 1}. {block.title}</span>
                    <span className="text-muted-foreground"> — {block.aim}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="rounded-md border border-border/50 bg-background/35 p-2 text-[12px] leading-relaxed text-foreground/75 whitespace-pre-line">
                Potřebné doplnění: {sessionView.goals.join("; ")}. Program zatím není připravený ke spuštění.
              </div>
            )}
            {p.proposed_session.kata_involvement && (
              <p className="text-[12px] text-muted-foreground italic whitespace-pre-line">
                {cleanVisibleClinicalText(p.proposed_session.kata_involvement)}
              </p>
            )}
            {sessionContextSummary && (
              <p className="rounded-md border border-border/50 bg-background/35 p-2 text-[12px] leading-relaxed text-foreground/75 whitespace-pre-line">
                {sanitizeProse(sessionContextSummary)}
              </p>
            )}
            <p className="text-[11px] text-primary/70 italic">
              Otevřít poradu →
            </p>
          </button>
        </>
      )}

      {/* 4.5 Dnešní navržená Herna — samostatný program vedený Karlem po schválení terapeutkami, nikdy ne plán terapeutického Sezení. */}
      {playroomProposal && playroomView && (
        <>
          <NarrativeDivider />
          <SectionHead icon={<Sparkles className="w-3.5 h-3.5 text-primary" />}>
            Návrh pro dnešní hernu
          </SectionHead>
          <button
            type="button"
            onClick={() => openProposedPlayroomDeliberation(playroomProposal)}
            className="mt-2 w-full text-left p-3 rounded-lg border border-primary/20 bg-primary/5 hover:bg-primary/10 transition-colors space-y-3 cursor-pointer"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <Badge className="text-[10px] h-5 px-2 bg-primary/15 text-primary border-primary/30">{playroomView.part_name}</Badge>
              <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">{playroomView.approval_label}</Badge>
              <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">{playroomView.lead_label}</Badge>
              <ArrowRight className="w-3.5 h-3.5 text-primary/60 ml-auto" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Cíl</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-foreground/85 whitespace-pre-line">{playroomView.title}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Proč dnes</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">{playroomView.rationale}</p>
            </div>
            {playroomContextSummary && <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">{playRecency?.is_yesterday ? "Použitý včerejší kontext" : "Použitý kontext z posledních dní"}</p><p className="mt-0.5 text-[12px] leading-relaxed text-foreground/75 whitespace-pre-line">{sanitizeProse(playroomContextSummary)}</p></div>}
            {Array.isArray(playroomProposal.goals) && playroomProposal.goals.length > 0 && (
              <div>
                <ul className="mt-1 space-y-1 text-[13px] leading-relaxed text-foreground/80">
                  {playroomView.goals.slice(0, 4).map((goal, index) => <li key={`${goal}-${index}`}>{index + 1}. {goal}</li>)}
                </ul>
              </div>
            )}
            {playroomView.blocks.length > 0 && (
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Program pro Hernu</p>
                <div className="mt-1 space-y-1.5">
                  {playroomView.blocks.map((block, index) => (
                    <p key={`${block.title}-${index}`} className="text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line"><span className="font-medium text-foreground/90">{index + 1}. {block.title}</span> — {block.aim}</p>
                  ))}
                </div>
              </div>
            )}
            {playroomView.child_safe_text && <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Dětsky bezpečná verze</p><p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">{playroomView.child_safe_text}</p></div>}
            {playroomView.stop_rules.length > 0 && <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Rizika a stop signály</p><p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">{playroomView.stop_rules.slice(0, 4).map((x) => `- ${x}`).join("\n")}</p></div>}
            <p className="text-[11px] text-primary/70 italic">Otevřít poradu ke schválení Herny →</p>
          </button>
        </>
      )}

      {/* DUPLICITY GUARD — když porada už schválena, briefing nezdvojuje plán.
          Autoritativní karta je v Pracovna → Dnes → "Plán dnešního sezení". */}
      {hasProposed && p.proposed_session && proposedAlreadyApproved && (
        <>
          <NarrativeDivider />
          <SectionHead icon={<Sparkles className="w-3.5 h-3.5 text-primary" />}>
            Dnešní sezení je schválené
          </SectionHead>
          <p className="mt-2 text-[12px] text-muted-foreground italic">
            Plán sezení s {p.proposed_session.part_name} je schválen oběma terapeutkami.
            Otevři ho v sekci <strong>Dnes → Plán dnešního sezení</strong>.
          </p>
        </>
      )}

      {/* 5. Co potřebuji od Haničky — KLIKATELNÉ → kanonický did_threads workspace */}
      {hankaItems.length > 0 && (
        <>
          <NarrativeDivider />
          <SectionHead>Haničko, potřebuji od tebe</SectionHead>
          <ul className="mt-2 space-y-1.5">
            {hankaItems.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={openingItemId === item.id}
                  onClick={() => {
                    if (item.requires_immediate_program_update || item.expected_resolution === "update_program") {
                      void openProgramAskDeliberation("ask_hanka", item);
                    } else {
                      void openAskWorkspace("ask_hanka", item);
                    }
                  }}
                  className="w-full text-left flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-primary/5 transition-colors cursor-pointer group disabled:opacity-60"
                >
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/40 group-hover:bg-primary/70 transition-colors" />
                  <span className="text-[13px] text-foreground/80 leading-relaxed flex-1">
                    {item.text}
                  </span>
                  {openingItemId === item.id ? (
                    <Loader2 className="w-3 h-3 text-primary animate-spin mt-1 shrink-0" />
                  ) : (
                    <ArrowRight className="w-3 h-3 text-muted-foreground/40 group-hover:text-primary/70 mt-1 shrink-0 transition-colors" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 6. Co potřebuji od Káti — KLIKATELNÉ → kanonický did_threads workspace */}
      {kataItems.length > 0 && (
        <>
          <NarrativeDivider />
          <SectionHead>Káťo, potřebuji od tebe</SectionHead>
          <ul className="mt-2 space-y-1.5">
            {kataItems.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={openingItemId === item.id}
                  onClick={() => {
                    if (item.requires_immediate_program_update || item.expected_resolution === "update_program") {
                      void openProgramAskDeliberation("ask_kata", item);
                    } else {
                      void openAskWorkspace("ask_kata", item);
                    }
                  }}
                  className="w-full text-left flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/5 transition-colors cursor-pointer group disabled:opacity-60"
                >
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/40 group-hover:bg-accent/70 transition-colors" />
                  <span className="text-[13px] text-foreground/80 leading-relaxed flex-1">
                    {item.text}
                  </span>
                  {openingItemId === item.id ? (
                    <Loader2 className="w-3 h-3 text-accent animate-spin mt-1 shrink-0" />
                  ) : (
                    <ArrowRight className="w-3 h-3 text-muted-foreground/40 group-hover:text-accent/70 mt-1 shrink-0 transition-colors" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 7. Společná porada týmu — KLIKATELNÉ → otevírá meeting */}
      {decisions.length > 0 && (
        <>
          <NarrativeDivider />
          <SectionHead icon={<Users className="w-3.5 h-3.5 text-primary" />}>
            Dnes potřebujeme rozhodnout společně
          </SectionHead>
          <ol className="mt-2 space-y-2">
            {decisions.map((d, i) => (
              <li key={i}>
                <button
                  type="button"
                  disabled={openingItemId === `decision::${d.title}`}
                  onClick={() => openDecisionDeliberation(d)}
                  className="w-full text-left rounded-lg border border-border/60 bg-card/40 hover:bg-card/70 hover:border-primary/30 p-3 space-y-1.5 transition-colors cursor-pointer group disabled:opacity-60"
                >
                  <div className="flex items-start gap-2">
                    <span className="text-[11px] text-muted-foreground font-mono mt-0.5">
                      {i + 1}.
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap mb-1">
                        <Badge
                          className={`text-[9px] h-4 px-1.5 border ${TYPE_TONE[d.type] ?? TYPE_TONE.clinical_decision}`}
                        >
                          {d.type === "crisis" && <AlertTriangle className="w-2.5 h-2.5 mr-0.5" />}
                          {TYPE_LABEL[d.type] ?? d.type}
                        </Badge>
                        {d.part_name && (
                          <Badge className="text-[9px] h-4 px-1.5 bg-muted text-muted-foreground border-border">
                            {d.part_name}
                          </Badge>
                        )}
                      </div>
                      <p className="text-[13px] font-medium text-foreground leading-snug">
                        {d.title}
                      </p>
                      <p className="text-[12px] text-foreground/70 leading-relaxed mt-1">
                        {d.reason}
                      </p>
                    </div>
                    <ArrowRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-primary/70 shrink-0 mt-0.5 transition-colors" />
                  </div>
                </button>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-[11px] text-muted-foreground italic">
            Kliknutím otevřete poradní místnost s podklady.
          </p>
        </>
      )}

      {/* 8. Na co čekám — POUZE pokud není duplicita s decisions / ask sekcemi.
          Filtrujeme: položka, která se už objevuje v ask_hanka/ask_kata/decisions
          (case-insensitive substring), se zde nezobrazí. */}
      {(() => {
        const askedTexts = [
          ...hankaItems.map(it => it.text),
          ...kataItems.map(it => it.text),
          ...decisions.map(d => d.title),
        ].map(s => (s ?? "").toLowerCase().slice(0, 40));

        const filteredWaiting = (p.waiting_for ?? []).filter(item => {
          const key = item.toLowerCase().slice(0, 40);
          return !askedTexts.some(a => a && (a.includes(key) || key.includes(a)));
        });

        if (filteredWaiting.length === 0) return null;

        return (
          <>
            <NarrativeDivider />
            <SectionHead>Ještě si potřebuji ujasnit</SectionHead>
            <ul className="mt-2 space-y-1.5">
              {filteredWaiting.map((item, i) => (
                <li key={i} className="text-[13px] text-foreground/75 flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                  <span className="leading-relaxed">{item}</span>
                </li>
              ))}
            </ul>
          </>
        );
      })()}

      {/* 9. Uzávěr */}
      {p.closing && (
        <>
          <NarrativeDivider />
          <p className="text-[13px] leading-relaxed text-foreground/75 italic whitespace-pre-line">
            {p.closing}
          </p>
        </>
      )}
      </>)}
    </div>
  );
};

export default DidDailyBriefingPanel;
