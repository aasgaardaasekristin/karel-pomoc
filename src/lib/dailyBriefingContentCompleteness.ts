/**
 * P33.7 — Daily Briefing Content Completeness Contract
 *
 * Defines the 9 mandatory sections a Karlův přehled must address every day.
 * A section may be `controlled_missing`, but then the visible briefing must
 * say exactly what is missing and what to do instead. Nothing may silently
 * disappear.
 *
 * Pure: no fetch, no AI, no DB. Reads only the already-built payload.
 *
 * Mirror: src/lib/dailyBriefingContentCompleteness.ts (1:1).
 */

export type RequiredBriefingSectionId =
  | "morning_readiness"
  | "yesterday_review"
  | "today_part_or_no_part_decision"
  | "today_session_playroom_plan"
  | "therapist_tasks"
  | "external_reality_context"
  | "risk_and_stop_signals"
  | "unknowns_and_limits"
  | "next_step";

export interface ContentCompletenessSection {
  section_id: RequiredBriefingSectionId;
  status: "complete" | "controlled_missing" | "blocked";
  source_tables: string[];
  source_fields: string[];
  evidence_count: number;
  controlled_missing_reason?: string;
  visible_summary_requirement: string;
}

export interface DailyBriefingContentCompleteness {
  version: "p33.7";
  checked_at: string;
  sections: Record<RequiredBriefingSectionId, ContentCompletenessSection>;
  overall_status: "complete" | "complete_with_controlled_missing" | "blocked";
  blocking_reasons: string[];
}

const REQUIRED_SECTIONS: RequiredBriefingSectionId[] = [
  "morning_readiness",
  "yesterday_review",
  "today_part_or_no_part_decision",
  "today_session_playroom_plan",
  "therapist_tasks",
  "external_reality_context",
  "risk_and_stop_signals",
  "unknowns_and_limits",
  "next_step",
];

function arr<T = any>(v: any): T[] {
  return Array.isArray(v) ? v : [];
}

function nonEmptyText(v: any): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

export function evaluateBriefingContentCompleteness(
  payload: any,
): DailyBriefingContentCompleteness {
  const checkedAt = new Date().toISOString();

  // 1. morning_readiness
  const truth = payload?.briefing_truth_gate ?? null;
  const truthOk = truth?.ok === true;
  const morning: ContentCompletenessSection = truthOk
    ? {
        section_id: "morning_readiness",
        status: "complete",
        source_tables: ["did_daily_cycles"],
        source_fields: ["briefing_truth_gate.ok", "briefing_truth_gate.source_cycle_id"],
        evidence_count: 1,
        visible_summary_requirement:
          "Karel řekne jednou větou, že ranní podklady jsou připravené a vázané na dnešní cyklus.",
      }
    : {
        section_id: "morning_readiness",
        status: "controlled_missing",
        source_tables: ["did_daily_cycles"],
        source_fields: ["briefing_truth_gate"],
        evidence_count: 0,
        controlled_missing_reason:
          "Ranní cyklus dnes neprošel kontrolou, takže s přehledem zacházíme opatrně.",
        visible_summary_requirement:
          "Karel výslovně řekne, že ranní podklady nejsou plně připravené a co to znamená.",
      };

  // 2. yesterday_review
  const ysess = payload?.yesterday_session_review ?? null;
  const yplay = payload?.yesterday_playroom_review ?? null;
  const sessExists = ysess?.exists === true || ysess?.held === true;
  const playExists = yplay?.exists === true || yplay?.held === true;
  const yReviewExists = sessExists || playExists;
  const yesterday: ContentCompletenessSection = yReviewExists
    ? {
        section_id: "yesterday_review",
        status: "complete",
        source_tables: ["did_session_reviews", "did_daily_session_plans", "did_threads"],
        source_fields: ["yesterday_session_review", "yesterday_playroom_review"],
        evidence_count: (sessExists ? 1 : 0) + (playExists ? 1 : 0),
        visible_summary_requirement:
          "Karel popíše, co bylo včera uzavřené, co zůstává otevřené a co z toho plyne pro dnešek.",
      }
    : {
        section_id: "yesterday_review",
        status: "controlled_missing",
        source_tables: ["did_session_reviews", "did_daily_session_plans", "did_threads"],
        source_fields: ["yesterday_session_review", "yesterday_playroom_review"],
        evidence_count: 0,
        controlled_missing_reason:
          "Včera nemám doložené dokončené Sezení ani Hernu; dnešní plán proto nesmí předpokládat navázání na hotový terapeutický materiál.",
        visible_summary_requirement:
          "Karel výslovně řekne, že včera nic doloženého nebylo, a co z toho plyne pro dnešek.",
      };

  // 3. today_part_or_no_part_decision
  const decision = payload?.today_part_relevance_decision ?? null;
  const tpp = payload?.today_part_proposal ?? null;
  const hasDecision = !!decision && typeof decision === "object";
  const okPrimary = decision?.ok_for_primary_suggestion === true;
  const partDecision: ContentCompletenessSection = hasDecision
    ? okPrimary
      ? {
          section_id: "today_part_or_no_part_decision",
          status: "complete",
          source_tables: ["did_part_registry", "did_threads", "did_live_session_progress"],
          source_fields: [
            "today_part_proposal",
            "today_part_relevance_decision.ok_for_primary_suggestion",
          ],
          evidence_count: 1,
          visible_summary_requirement:
            "Karel pojmenuje navrženou část a důvod, proč ji dnes nabízí jako vedoucí.",
        }
      : {
          section_id: "today_part_or_no_part_decision",
          status: "controlled_missing",
          source_tables: ["did_part_registry", "did_threads", "did_live_session_progress"],
          source_fields: ["today_part_relevance_decision.reason"],
          evidence_count: nonEmptyText(tpp?.proposed_part ?? tpp?.part_name) ? 1 : 0,
          controlled_missing_reason:
            "Dnes není dost opory vybrat konkrétní část před prvním kontaktem; potřebujeme operační plán bez vedoucí části.",
          visible_summary_requirement:
            "Karel řekne, že dnes nevybírá vedoucí část, a okamžitě nabídne tři cesty pro první kontakt (Sezení / stabilizační Herna / bezpečný kontakt) plus stop signály.",
        }
    : {
        section_id: "today_part_or_no_part_decision",
        status: "blocked",
        source_tables: ["did_part_registry"],
        source_fields: ["today_part_relevance_decision"],
        evidence_count: 0,
        controlled_missing_reason: "today_part_relevance_decision chybí v payloadu.",
        visible_summary_requirement:
          "Renderer použije bezpečný operační fallback bez vedoucí části.",
      };

  // 4. today_session_playroom_plan
  const sess = payload?.proposed_session ?? null;
  const play = payload?.proposed_playroom ?? null;
  const sessTitle = nonEmptyText(sess?.title || sess?.theme || sess?.focus);
  const playTitle = nonEmptyText(play?.title || play?.theme || play?.focus);
  const planSec: ContentCompletenessSection = (sessTitle || playTitle)
    ? {
        section_id: "today_session_playroom_plan",
        status: "complete",
        source_tables: ["did_team_deliberations", "did_daily_session_plans"],
        source_fields: ["proposed_session", "proposed_playroom"],
        evidence_count: (sessTitle ? 1 : 0) + (playTitle ? 1 : 0),
        visible_summary_requirement:
          "Karel ukáže schválený rámec Sezení nebo Herny s tématem a klíčovou pozorností dne.",
      }
    : {
        section_id: "today_session_playroom_plan",
        status: "controlled_missing",
        source_tables: ["did_team_deliberations", "did_daily_session_plans"],
        source_fields: ["proposed_session", "proposed_playroom"],
        evidence_count: 0,
        controlled_missing_reason:
          "Žádný schválený plán Sezení ani Herny pro dnešek neexistuje; potřebujeme rozhodovací protokol.",
        visible_summary_requirement:
          "Karel výslovně řekne, že schválený plán neexistuje, a nabídne rozhodovací protokol: kdy zvolit Sezení, kdy stabilizační Hernu, kdy jen bezpečný kontakt.",
      };

  // 5. therapist_tasks (must be CONCRETE — first-contact / risk-stop / route)
  const askH = arr<any>(payload?.ask_hanka);
  const askK = arr<any>(payload?.ask_kata);
  const hasH = askH.length > 0 && nonEmptyText(askH[0]?.text);
  const hasK = askK.length > 0 && nonEmptyText(askK[0]?.text);
  const tasksSec: ContentCompletenessSection = (hasH || hasK)
    ? {
        section_id: "therapist_tasks",
        status: "complete",
        source_tables: ["did_pending_questions"],
        source_fields: ["ask_hanka", "ask_kata"],
        evidence_count: (hasH ? askH.length : 0) + (hasK ? askK.length : 0),
        visible_summary_requirement:
          "Karel dá Haničce konkrétní first-contact check a Káťe konkrétní risk/stop check; ne generické ‚prosím ověř‘.",
      }
    : {
        section_id: "therapist_tasks",
        status: "controlled_missing",
        source_tables: ["did_pending_questions"],
        source_fields: ["ask_hanka", "ask_kata"],
        evidence_count: 0,
        controlled_missing_reason:
          "Pro Haničku ani Káťu nejsou v podkladech žádné přípravené úkoly; renderer doplní bezpečnostní first-contact rámec.",
        visible_summary_requirement:
          "Karel doplní defaultní first-contact úkol pro Haničku (kontakt s kluky, ochota navázat) a risk/stop check pro Káťu (rizika, stop signály).",
      };

  // 6. external_reality_context
  const ext = payload?.external_reality_watch ?? null;
  const ps = String(ext?.provider_status ?? "");
  const partsArr = arr<any>(ext?.parts);
  const extConfigured = ps === "configured";
  const extSec: ContentCompletenessSection = ext && extConfigured
    ? {
        section_id: "external_reality_context",
        status: "complete",
        source_tables: ["external_reality_events", "active_part_daily_brief"],
        source_fields: [
          "external_reality_watch.provider_status",
          "external_reality_watch.parts",
        ],
        evidence_count: partsArr.length,
        visible_summary_requirement:
          "Karel pro každého ovlivněného kluka uvede kategorii / jméno části / doménu zdroje / datum / recency tier; bezpečným jazykem.",
      }
    : {
        section_id: "external_reality_context",
        status: "controlled_missing",
        source_tables: ["external_reality_events", "active_part_daily_brief"],
        source_fields: ["external_reality_watch.provider_status"],
        evidence_count: 0,
        controlled_missing_reason: ext
          ? `Externí situační přehled dnes nemá použitelné výstupy (provider_status=${ps || "unknown"}).`
          : "Externí situační přehled dnes nemáme k dispozici.",
        visible_summary_requirement:
          "Karel výslovně řekne, že o vnějších událostech dnes nic netvrdí, a co to znamená pro práci.",
      };

  // 7. risk_and_stop_signals
  const lingering = arr<any>(payload?.lingering);
  const partsWithFresh = partsArr.filter((p: any) =>
    arr(p?.internet_triggers_today).some(
      (t: any) =>
        t?.freshness?.display_tier === "fresh_today_event" ||
        t?.freshness?.ok_for_today_display === true,
    ),
  ).length;
  const riskSec: ContentCompletenessSection = (lingering.length > 0 || partsWithFresh > 0)
    ? {
        section_id: "risk_and_stop_signals",
        status: "complete",
        source_tables: ["external_reality_events", "did_threads"],
        source_fields: ["lingering", "external_reality_watch.parts"],
        evidence_count: lingering.length + partsWithFresh,
        visible_summary_requirement:
          "Karel pojmenuje nesená témata a čerstvě zachycené vnější okruhy bezpečným jazykem.",
      }
    : {
        section_id: "risk_and_stop_signals",
        status: "controlled_missing",
        source_tables: ["external_reality_events", "did_threads"],
        source_fields: ["lingering", "external_reality_watch.parts"],
        evidence_count: 0,
        controlled_missing_reason:
          "V podkladech nevidím dnes označené konkrétní riziko ani citlivost.",
        visible_summary_requirement:
          "Karel řekne, že žádné konkrétní riziko v podkladech nevidí, a doplní obecnou opatrnost (stop signály při prvním kontaktu).",
      };

  // 8. unknowns_and_limits
  const unknownsSec: ContentCompletenessSection = {
    section_id: "unknowns_and_limits",
    status: "complete",
    source_tables: ["briefing_truth_gate"],
    source_fields: [
      "briefing_truth_gate.ok",
      "external_reality_watch.provider_status",
      "today_part_proposal",
    ],
    evidence_count: 1,
    visible_summary_requirement:
      "Karel výslovně vyjmenuje, co dnes neví a co si nebude domýšlet.",
  };

  // 9. next_step
  const dtp = nonEmptyText(payload?.daily_therapeutic_priority);
  const nextSec: ContentCompletenessSection = dtp
    ? {
        section_id: "next_step",
        status: "complete",
        source_tables: ["did_daily_cycles"],
        source_fields: ["daily_therapeutic_priority"],
        evidence_count: 1,
        visible_summary_requirement:
          "Karel nabídne jeden opatrný další krok pro dnešek.",
      }
    : {
        section_id: "next_step",
        status: "controlled_missing",
        source_tables: ["did_daily_cycles"],
        source_fields: ["daily_therapeutic_priority"],
        evidence_count: 0,
        controlled_missing_reason:
          "Pro dnešek není v podkladech přesný další krok; vyjdeme z prvního kontaktu s kluky.",
        visible_summary_requirement:
          "Karel řekne, že konkrétní další krok určí až podle prvního kontaktu, a co se zatím dělat nemá.",
      };

  const sections: Record<RequiredBriefingSectionId, ContentCompletenessSection> = {
    morning_readiness: morning,
    yesterday_review: yesterday,
    today_part_or_no_part_decision: partDecision,
    today_session_playroom_plan: planSec,
    therapist_tasks: tasksSec,
    external_reality_context: extSec,
    risk_and_stop_signals: riskSec,
    unknowns_and_limits: unknownsSec,
    next_step: nextSec,
  };

  const blocking = REQUIRED_SECTIONS
    .map((id) => sections[id])
    .filter((s) => s.status === "blocked")
    .map((s) => `${s.section_id}:${s.controlled_missing_reason ?? "blocked"}`);

  const anyControlled = REQUIRED_SECTIONS.some(
    (id) => sections[id].status === "controlled_missing",
  );

  const overall_status: DailyBriefingContentCompleteness["overall_status"] =
    blocking.length > 0
      ? "blocked"
      : anyControlled
        ? "complete_with_controlled_missing"
        : "complete";

  return {
    version: "p33.7",
    checked_at: checkedAt,
    sections,
    overall_status,
    blocking_reasons: blocking,
  };
}

export const REQUIRED_BRIEFING_SECTIONS = REQUIRED_SECTIONS;
