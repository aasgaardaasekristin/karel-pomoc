/**
 * dailyLifecycle.ts — Slice 3B (Daily Lifecycle + Decision Deck Cleanup)
 *
 * Logický (DERIVED) lifecycle nad existujícími zdroji:
 *   - did_therapist_tasks
 *   - did_pending_questions
 *   - briefing waiting items (DidDailyBriefing payload)
 *   - crisis_events (deficits dne)
 *   - briefing.proposed_sessions / did_daily_session_plans
 *
 * Tento soubor je **čistě typový kontrakt**. Nezavádí žádnou DB migraci.
 * Mapování zdroj → stav drží `src/lib/dailyLifecycleResolver.ts`.
 *
 * Slovník stavů odpovídá Slice 2 RE-ANCHOR SPECu (sekce B).
 * Když některý zdroj nedokáže rozlišit konkrétní podstav, resolver volí
 * NEJBEZPEČNĚJŠÍ klasifikaci (typicky `waiting_response` místo `done`).
 */

/** Logický lifecycle stav položky dne. */
export type DailyLifecycleStatus =
  | "new_today"              // dnes vzniklo / dnes se objevilo jako požadavek
  | "waiting_response"       // čeká na odpověď terapeutky / Káti / klienta
  | "needs_reissue"          // expirovalo nebo ztratilo platnost a je třeba znovu otevřít
  | "escalate_to_meeting"    // překlopit do porady / supervize (např. eskalace tasku)
  | "scheduled_for_session"  // patří do dnešního session plánu
  | "done"                   // uzavřeno (answered / completed / archived s completion)
  | "dropped"                // uzavřeno bez výsledku (archived bez completion, manual drop)
  | "not_relevant_anymore";  // ztratilo relevanci kontextem (closed crisis, expired bez reissue need)

/** Zdroj, ze kterého položka vznikla (pro UI traceability + routing zpět). */
export type DailyLifecycleSource =
  | "task"
  | "pending_question"
  | "briefing_ask"          // ask_hanka / ask_kata z briefingu
  | "briefing_decision"     // decisions z briefingu
  | "crisis_deficit"        // dnešní deficit z crisis_events
  | "session_proposal";     // proposed_session z briefingu / did_daily_session_plans

/** Komu je položka adresována (pro decision deck filtrování). */
export type DailyLifecycleAudience =
  | "hanka"
  | "kata"
  | "both"
  | "karel"      // Karlova vlastní rozhodovací akce (např. crisis deficit "chybí dnešní hodnocení")
  | "system"
  | "unknown";

/**
 * Univerzální view-model položky dne. Resolver promítá heterogenní zdroje
 * (tasks, questions, briefing, crisis) do tohoto jednotného tvaru, aby
 * UI mohlo filtrovat a grupovat bez znalosti původu.
 */
export interface DailyLifecycleItem {
  /** Stabilní ID (typicky row.id ze zdrojové tabulky). */
  id: string;
  /** Logický stav (viz DailyLifecycleStatus). */
  status: DailyLifecycleStatus;
  /** Odkud položka vznikla. */
  source: DailyLifecycleSource;
  /** Komu je adresována. */
  audience: DailyLifecycleAudience;
  /** Krátký titulek pro decision deck (jednořádkový). */
  title: string;
  /** Volitelné rationale (proč to dnes řešit) — také jednořádkové, pro decision deck. */
  rationale?: string;
  /** Zda položka aktivně blokuje rozhodnutí (drží decision deck zúžený). */
  isBlocking: boolean;
  /** Zda zápis vznikl dnes (Prague day). */
  isToday: boolean;
  /** ISO timestamp vzniku. */
  createdAt: string;
  /** ISO timestamp due (pokud existuje). */
  dueAt?: string | null;
  /** ISO timestamp expirace (pokud existuje). */
  expiresAt?: string | null;
  /** Volný odkaz na původní part / klienta / krizi pro routing. */
  partName?: string | null;
  /** Crisis event ID, pokud je položka navázaná na krizi. */
  crisisEventId?: string | null;
}

/**
 * Praktické sety pro UI. Hook `useDailyLifecycle()` plní tyto bukety
 * z výstupu resolveru, aby konzumující komponenty byly co nejjednodušší.
 */
export interface DailyLifecycleBuckets {
  newToday: DailyLifecycleItem[];
  waitingResponse: DailyLifecycleItem[];
  needsReissue: DailyLifecycleItem[];
  escalateToMeeting: DailyLifecycleItem[];
  scheduledForSession: DailyLifecycleItem[];
  done: DailyLifecycleItem[];
  dropped: DailyLifecycleItem[];
  notRelevantAnymore: DailyLifecycleItem[];
  /**
   * Decision deck subset (Karlův přehled).
   * = new_today ∪ needs_reissue ∪ escalate_to_meeting ∪ blocking(waiting_response)
   * Slice 2 spec sekce D.
   */
  decisionDeck: DailyLifecycleItem[];
  /**
   * Operativa dne subset (active execution).
   * = waiting_response (vše) ∪ scheduled_for_session ∪ needs_reissue
   * Bez decision-only "new_today karel-side" položek.
   * Slice 2 spec sekce E.
   */
  operationalToday: DailyLifecycleItem[];
}

export const EMPTY_BUCKETS: DailyLifecycleBuckets = {
  newToday: [],
  waitingResponse: [],
  needsReissue: [],
  escalateToMeeting: [],
  scheduledForSession: [],
  done: [],
  dropped: [],
  notRelevantAnymore: [],
  decisionDeck: [],
  operationalToday: [],
};
