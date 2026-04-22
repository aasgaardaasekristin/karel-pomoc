/**
 * TeamDeliberation — kanonický workflow objekt pro společné porady
 * Karel ↔ Hanička ↔ Káťa.
 *
 * NENÍ to live sezení. Live sezení žije v `did_daily_session_plans`
 * (kanonický plán) + Chat (`didFlowState=live-session`, runtime).
 *
 * Porada končí trojnásobným podpisem (hanka_signed_at, kata_signed_at,
 * karel_signed_at) → status = 'approved' → bridge propíše schválený
 * plán do `did_daily_session_plans` (pro typ `session_plan`).
 */

export type DeliberationStatus =
  | "draft"
  | "active"
  | "awaiting_signoff"
  | "approved"
  | "closed"
  | "archived";

export type DeliberationPriority =
  | "low"
  | "normal"
  | "high"
  | "urgent"
  | "crisis";

/**
 * Povolené důvody vzniku týmové porady. Žádný individuální task,
 * žádná běžná operativa bez potřeby společného signoffu.
 */
export type DeliberationType =
  | "team_task"          // společné klinické rozhodnutí
  | "session_plan"       // plán dnešního/zítřejšího live sezení
  | "crisis"             // krizová koordinace
  | "followup_review"    // vyhodnocení uplynulého sezení
  | "supervision";       // supervizní bod

export interface DeliberationQuestion {
  id?: string;
  question: string;
  answer?: string | null;
  answered_at?: string | null;
}

export interface DiscussionMessage {
  id?: string;
  author: "karel" | "hanka" | "kata";
  content: string;
  created_at: string;
  /** when karel posts a revised plan after a therapist's reply */
  is_plan_revision?: boolean;
}

/**
 * SLICE 3 — Strukturovaná osnova porady (zejména pro session_plan).
 * Renderuje se v DeliberationRoom jako minutáž / kroky:
 *   - block: krátký název kroku ("Úvod a ground-check")
 *   - minutes: doporučená doba v minutách (volitelné)
 *   - detail: 1-2 věty co se v bloku děje
 */
export interface AgendaBlock {
  block: string;
  minutes?: number | null;
  detail?: string | null;
}

export interface TeamDeliberation {
  id: string;
  user_id: string;

  title: string;
  reason: string | null;
  status: DeliberationStatus;
  priority: DeliberationPriority;
  deliberation_type: DeliberationType;

  subject_parts: string[];
  participants: string[];
  created_by: string;

  initial_karel_brief: string | null;
  karel_proposed_plan: string | null;
  questions_for_hanka: DeliberationQuestion[];
  questions_for_kata: DeliberationQuestion[];

  /**
   * SLICE 3 — strukturovaná osnova / minutáž porady.
   * Pro session_plan obsahuje typicky 4-6 bloků (ground-check, hlavní práce,
   * uzávěr, …). Pro ostatní typy může být prázdné pole.
   */
  agenda_outline: AgendaBlock[];

  discussion_log: DiscussionMessage[];

  hanka_signed_at: string | null;
  kata_signed_at: string | null;
  karel_signed_at: string | null;

  linked_live_session_id: string | null;   // → did_daily_session_plans.id
  linked_task_id: string | null;
  linked_drive_write_id: string | null;
  linked_crisis_event_id: string | null;

  /**
   * SLICE 3 — kanonické navázání na konkrétní položku denního briefingu.
   * Druhý klik na stejný `decisions[i]` / `proposed_session` v
   * DidDailyBriefingPanel resolvuje EXISTUJÍCÍ poradu přes
   * (linked_briefing_id, linked_briefing_item_id) místo fuzzy text matchu.
   */
  linked_briefing_id: string | null;
  linked_briefing_item_id: string | null;

  final_summary: string | null;
  followup_needed: boolean;

  /**
   * Karlova explicitní syntéza odpovědí Haničky a Káti + discussion_logu.
   * Povinná pro aktivaci Karlova podpisu u typu `crisis`.
   * Naplněná edge funkcí `karel-team-deliberation-synthesize`.
   */
  karel_synthesis: KarelSynthesis | null;
  karel_synthesized_at: string | null;

  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface KarelSynthesis {
  verdict: "crisis_persists" | "crisis_easing" | "crisis_resolvable" | "non_crisis";
  next_step: string;
  needs_karel_interview: boolean;
  key_insights: string[];
  drive_writeback_md: string;
  recommended_session_focus: string | null;
  risk_signals: string[];
  protective_signals: string[];
}

/* ================================================================
   DASHBOARD VISIBILITY POLICY
   Agresivní limit — dashboard NENÍ backlog.
   ================================================================ */

export const DASHBOARD_MAX_NORMAL = 2;
export const DASHBOARD_MAX_CRISIS_BONUS = 1;

/**
 * Vrátí, které porady se mají zobrazit na hlavním dashboardu.
 * Pravidlo:
 *   - max 2 aktivní normální (active / awaiting_signoff)
 *   - + 1 navíc pokud je to krize
 *   - vše ostatní → "další otevřené (N)" sklápěcí sekce
 *
 * Řazení uvnitř obou bucketů: priority desc, updated_at desc.
 */
/**
 * Final Pracovna Cleanup Verdict (2026-04-21):
 * Testovací / throwaway porady (CLOSEOUT TEST, throwaway, UI proof, …)
 * NIKDY nesmí být vidět na hlavní Pracovna ploše. Filtruje se v dashboard
 * partition (overflow je nezahrnuje vůbec).
 */
const TEST_TITLE_PATTERNS = [
  /\[?\s*closeout\s*test/i,
  /throwaway/i,
  /ui\s*proof/i,
  /\btest\s*porada\b/i,
  /\bsmoke\s*test\b/i,
];

function isTestDeliberation(d: TeamDeliberation): boolean {
  const haystack = `${d.title || ""} ${d.reason || ""}`;
  return TEST_TITLE_PATTERNS.some((rx) => rx.test(haystack));
}

export function partitionDashboardDeliberations(
  list: TeamDeliberation[]
): { primary: TeamDeliberation[]; overflow: TeamDeliberation[] } {
  const PRIORITY_RANK: Record<DeliberationPriority, number> = {
    crisis: 0,
    urgent: 1,
    high: 2,
    normal: 3,
    low: 4,
  };
  const open = list.filter(
    (d) =>
      (d.status === "active" || d.status === "awaiting_signoff" || d.status === "approved") &&
      !isTestDeliberation(d)
  );
  const sorted = [...open].sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] ?? 5;
    const pb = PRIORITY_RANK[b.priority] ?? 5;
    if (pa !== pb) return pa - pb;
    return (
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
  });

  const primary: TeamDeliberation[] = [];
  let crisisSlotUsed = false;

  for (const d of sorted) {
    if (primary.length < DASHBOARD_MAX_NORMAL) {
      primary.push(d);
      continue;
    }
    // bonus crisis slot
    if (
      !crisisSlotUsed &&
      (d.priority === "crisis" || d.deliberation_type === "crisis")
    ) {
      primary.push(d);
      crisisSlotUsed = true;
      continue;
    }
    break;
  }

  const primaryIds = new Set(primary.map((d) => d.id));
  const overflow = sorted.filter((d) => !primaryIds.has(d.id));
  return { primary, overflow };
}

/**
 * Tvrdá guard funkce — povolené typy porad.
 * Cokoliv mimo tyto typy by NIKDY nemělo vzniknout jako TeamDeliberation:
 *   - individuální task pro Haničku
 *   - individuální task pro Káťu
 *   - běžná operativa bez společného rozhodnutí
 */
export function isAllowedDeliberationReason(
  type: DeliberationType
): boolean {
  return (
    type === "team_task" ||
    type === "session_plan" ||
    type === "crisis" ||
    type === "followup_review" ||
    type === "supervision"
  );
}

/**
 * SESSION PREP SIGNOFF FIX (2026-04-21):
 * Pro `session_plan` je workflow gated POUZE dvěma terapeutickými podpisy
 * (Hanička + Káťa). Karel se podepíše automaticky na serveru.
 * Pro ostatní typy zůstává klasický 3-podpisový model (vč. krize, kde
 * Karlův podpis je gated synthesí).
 */
export function signoffProgress(d: TeamDeliberation): {
  signed: number;
  total: number;
  missing: Array<"hanka" | "kata" | "karel">;
} {
  const isSessionPlan = d.deliberation_type === "session_plan";
  const requiredSigners: Array<"hanka" | "kata" | "karel"> = isSessionPlan
    ? ["hanka", "kata"]
    : ["hanka", "kata", "karel"];
  const missing: Array<"hanka" | "kata" | "karel"> = [];
  for (const who of requiredSigners) {
    const ts =
      who === "hanka" ? d.hanka_signed_at :
      who === "kata" ? d.kata_signed_at : d.karel_signed_at;
    if (!ts) missing.push(who);
  }
  return {
    signed: requiredSigners.length - missing.length,
    total: requiredSigners.length,
    missing,
  };
}
